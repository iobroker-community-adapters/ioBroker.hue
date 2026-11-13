/**
 * Translates writes to ioBroker states into commands for the Hue API v2.
 *
 * Everything in here is pure (no adapter access), so it can be unit tested.
 */
import { clampToGamut, kelvinToMirek, parseHexColor, parseXy, rgbToXy } from './color';
import type { ResourceCommand } from './hue/commandQueue';
import type { DeviceResource, GroupResource, LightResource, MotionResource, SceneResource, XY } from './hue/types';
import { membersOf, type Entity } from './model';
import type { ResourceIndex } from './resourceIndex';

/** Options which influence how commands are built */
export interface CommandOptions {
    /** Turn lights on when color, color temperature or effect is changed */
    turnOnWithOthers: boolean;
}

/** Error caused by invalid user input */
export class CommandError extends Error {
    /**
     * @param message description of the problem
     */
    constructor(message: string) {
        super(message);
        this.name = 'CommandError';
    }
}

/** Keys supported by the `command` state */
const COMMAND_KEYS = [
    'on',
    'brightness',
    'brightnessDelta',
    'colorTemperature',
    'xy',
    'rgb',
    'effect',
    'alert',
    'transition',
    'scene',
] as const;

type LightCommand = Partial<Record<(typeof COMMAND_KEYS)[number], unknown>>;

/** States of lights and groups which map directly to a command key */
const DIRECT_STATES = ['on', 'brightness', 'colorTemperature', 'xy', 'rgb', 'effect', 'alert'];

/**
 * Convert a value to a finite number or throw
 *
 * @param value the value
 * @param key name used in the error message
 */
function toNumber(value: unknown, key: string): number {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (typeof num !== 'number' || !isFinite(num)) {
        throw new CommandError(`Invalid value for "${key}": ${JSON.stringify(value)}`);
    }
    return num;
}

/**
 * Convert a value to boolean, accepting common string representations
 *
 * @param value the value
 */
function toBoolean(value: unknown): boolean {
    if (typeof value === 'string') {
        return ['true', '1', 'on'].includes(value.trim().toLowerCase());
    }
    return !!value;
}

/**
 * Parse the value of a `command` state
 *
 * @param value JSON string or object
 */
export function parseCommand(value: unknown): LightCommand {
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            throw new CommandError(`Command is not valid JSON: ${value}`);
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CommandError('Command has to be a JSON object');
    }

    const unknownKeys = Object.keys(parsed).filter(k => !(COMMAND_KEYS as readonly string[]).includes(k));
    if (unknownKeys.length) {
        throw new CommandError(
            `Unsupported command key(s): ${unknownKeys.join(', ')} - supported are ${COMMAND_KEYS.join(', ')}`,
        );
    }

    return parsed;
}

/**
 * Build the body for a light or grouped_light from a command
 *
 * @param cmd the command
 * @param lights affected lights (used for validation and gamut correction)
 * @param isGroup if the target is a grouped_light
 * @param options command options
 */
export function buildLightBody(
    cmd: LightCommand,
    lights: LightResource[],
    isGroup: boolean,
    options: CommandOptions,
): Record<string, unknown> {
    const body: Record<string, any> = {};
    let implicitOn = false;
    const single = isGroup ? undefined : lights[0];

    if (cmd.brightness !== undefined) {
        const brightness = toNumber(cmd.brightness, 'brightness');
        if (brightness <= 0) {
            body.on = { on: false };
        } else {
            body.dimming = { brightness: Math.min(100, brightness) };
            implicitOn = true;
        }
    }

    if (cmd.brightnessDelta !== undefined) {
        const delta = toNumber(cmd.brightnessDelta, 'brightnessDelta');
        if (delta !== 0) {
            body.dimming_delta = {
                action: delta > 0 ? 'up' : 'down',
                brightness_delta: Math.min(100, Math.abs(delta)),
            };
        }
    }

    if (cmd.colorTemperature !== undefined) {
        const kelvin = toNumber(cmd.colorTemperature, 'colorTemperature');
        if (kelvin <= 0) {
            throw new CommandError(`Invalid color temperature: ${kelvin}`);
        }

        const schemas = lights
            .map(l => l.color_temperature?.mirek_schema)
            .filter((s): s is NonNullable<typeof s> => !!s);
        if (!lights.some(l => l.color_temperature)) {
            throw new CommandError('Color temperature is not supported');
        }

        const min = schemas.length ? Math.min(...schemas.map(s => s.mirek_minimum)) : 153;
        const max = schemas.length ? Math.max(...schemas.map(s => s.mirek_maximum)) : 500;
        body.color_temperature = { mirek: Math.min(max, Math.max(min, kelvinToMirek(kelvin))) };
        implicitOn = true;
    }

    let xy: XY | undefined;
    if (cmd.xy !== undefined) {
        xy = parseXy(cmd.xy);
        if (!xy) {
            throw new CommandError(`Invalid xy value: ${JSON.stringify(cmd.xy)} - expected "x,y" with values 0..1`);
        }
    }
    if (cmd.rgb !== undefined) {
        const rgb = parseHexColor(cmd.rgb);
        if (!rgb) {
            throw new CommandError(`Invalid rgb value: ${JSON.stringify(cmd.rgb)} - expected "#RRGGBB"`);
        }
        xy = rgbToXy(rgb);
        if (!xy) {
            throw new CommandError('Black has no color, use "on" or "brightness" to turn the light off');
        }
    }
    if (xy) {
        if (!lights.some(l => l.color)) {
            throw new CommandError('Color is not supported');
        }
        body.color = { xy: single ? clampToGamut(xy, single.color?.gamut) : xy };
        implicitOn = true;
    }

    if (cmd.effect !== undefined) {
        if (isGroup) {
            throw new CommandError('Effects are not supported for groups');
        }
        if (typeof cmd.effect !== 'string') {
            throw new CommandError(`Invalid effect: ${JSON.stringify(cmd.effect)}`);
        }
        const effect = cmd.effect;
        const supported = single?.effects?.effect_values ?? [];
        if (!supported.includes(effect)) {
            throw new CommandError(`Effect "${effect}" is not supported, supported are: ${supported.join(', ')}`);
        }
        body.effects = { effect };
        implicitOn ||= effect !== 'no_effect';
    }

    if (cmd.alert !== undefined && toBoolean(cmd.alert)) {
        body.alert = { action: 'breathe' };
    }

    if (cmd.on !== undefined) {
        body.on = { on: toBoolean(cmd.on) };
    } else if (implicitOn && !body.on) {
        // brightness always turns the light on, other properties only if configured
        if (body.dimming || options.turnOnWithOthers) {
            body.on = { on: true };
        }
    }

    if (cmd.transition !== undefined) {
        const duration = Math.round(toNumber(cmd.transition, 'transition'));
        if (duration < 0) {
            throw new CommandError(`Invalid transition: ${duration}`);
        }
        if (Object.keys(body).length) {
            body.dynamics = { duration };
        }
    }

    return body;
}

/**
 * Find a scene of a group by name or id
 *
 * @param index all resources
 * @param groupId id of the room or zone
 * @param nameOrId scene name (case-insensitive) or id
 */
function findScene(index: ResourceIndex, groupId: string, nameOrId: string): SceneResource | undefined {
    const needle = nameOrId.trim().toLowerCase();
    return index
        .ofType<SceneResource>('scene')
        .filter(s => s.group.rid === groupId)
        .find(s => s.id === nameOrId || s.metadata.name.toLowerCase() === needle);
}

/**
 * Build the commands for a light or group
 *
 * @param entity light or group entity
 * @param cmd the command
 * @param index all resources
 * @param options command options
 */
function lightOrGroupCommands(
    entity: Entity & { kind: 'light' | 'group' },
    cmd: LightCommand,
    index: ResourceIndex,
    options: CommandOptions,
): ResourceCommand[] {
    if (entity.kind === 'light') {
        if (cmd.scene !== undefined) {
            throw new CommandError('Scenes can only be activated for rooms and zones');
        }
        const light = index.get<LightResource>(entity.lightId);
        if (!light) {
            throw new CommandError(`Light "${entity.name}" does not exist anymore`);
        }
        const body = buildLightBody(cmd, [light], false, options);
        return Object.keys(body).length ? [{ rtype: 'light', rid: light.id, body }] : [];
    }

    const group = index.get<GroupResource>(entity.groupId);
    if (!group) {
        throw new CommandError(`Group "${entity.name}" does not exist anymore`);
    }

    const commands: ResourceCommand[] = [];
    let rest = cmd;

    if (cmd.scene !== undefined) {
        if (typeof cmd.scene !== 'string') {
            throw new CommandError(`Invalid scene: ${JSON.stringify(cmd.scene)}`);
        }
        const scene = findScene(index, group.id, cmd.scene);
        if (!scene) {
            throw new CommandError(`Scene "${cmd.scene}" not found in "${entity.name}"`);
        }

        const recall: Record<string, unknown> = { action: 'active' };
        if (cmd.transition !== undefined) {
            recall.duration = Math.max(0, Math.round(toNumber(cmd.transition, 'transition')));
        }
        if (cmd.brightness !== undefined) {
            recall.dimming = { brightness: Math.min(100, Math.max(1, toNumber(cmd.brightness, 'brightness'))) };
        }
        commands.push({ rtype: 'scene', rid: scene.id, body: { recall } });

        // scene, transition and brightness are handled by the recall

        const { scene: _scene, transition: _transition, brightness: _brightness, ...others } = cmd;
        rest = others;
    }

    const body = buildLightBody(rest, membersOf(group, index), true, options);
    if (Object.keys(body).length) {
        commands.push({ rtype: 'grouped_light', rid: entity.groupedLightId, body });
    }

    return commands;
}

/**
 * Translate a write to a state into commands for the bridge
 *
 * @param entity entity the state belongs to
 * @param stateId id of the state relative to the namespace
 * @param value the written value
 * @param index all resources
 * @param options command options
 */
export function buildCommands(
    entity: Entity,
    stateId: string,
    value: ioBroker.StateValue,
    index: ResourceIndex,
    options: CommandOptions,
): ResourceCommand[] {
    const suffix = stateId === entity.id ? '' : stateId.slice(entity.id.length + 1);

    switch (entity.kind) {
        case 'light':
        case 'group': {
            if (suffix === 'command') {
                return lightOrGroupCommands(entity, parseCommand(value), index, options);
            }
            if (DIRECT_STATES.includes(suffix)) {
                if (suffix === 'alert' && !toBoolean(value)) {
                    return [];
                }
                return lightOrGroupCommands(entity, { [suffix]: value }, index, options);
            }
            break;
        }

        case 'sensor': {
            if (suffix === 'motionEnabled') {
                const device = index.get<DeviceResource>(entity.deviceId);
                const motion =
                    index.servicesOf<MotionResource>(device, 'motion')[0] ??
                    index.servicesOf<MotionResource>(device, 'camera_motion')[0];
                if (!motion) {
                    throw new CommandError(`"${entity.name}" has no motion sensor`);
                }
                return [{ rtype: motion.type, rid: motion.id, body: { enabled: toBoolean(value) } }];
            }
            break;
        }

        case 'scene':
            return toBoolean(value)
                ? [{ rtype: 'scene', rid: entity.sceneId, body: { recall: { action: 'active' } } }]
                : [];

        case 'smartScene':
            return [
                {
                    rtype: 'smart_scene',
                    rid: entity.sceneId,
                    body: { recall: { action: toBoolean(value) ? 'activate' : 'deactivate' } },
                },
            ];

        case 'entertainment':
            return [
                {
                    rtype: 'entertainment_configuration',
                    rid: entity.configurationId,
                    body: { action: toBoolean(value) ? 'start' : 'stop' },
                },
            ];

        case 'automation':
            return [{ rtype: 'behavior_instance', rid: entity.behaviorId, body: { enabled: toBoolean(value) } }];
    }

    throw new CommandError(`State "${stateId}" is read-only`);
}
