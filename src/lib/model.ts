/**
 * Builds the ioBroker object tree and state values from the resources of the bridge.
 *
 * Everything in here is pure (no adapter access), so it can be unit tested.
 */
import { formatHexColor, formatXy, lightLevelToLux, mirekToKelvin, xyToRgb } from './color';
import type { ResourceIndex } from './resourceIndex';
import type {
    BehaviorInstanceResource,
    ButtonEvent,
    ButtonResource,
    ContactResource,
    DevicePowerResource,
    DeviceResource,
    EntertainmentConfigurationResource,
    GroupedLightResource,
    GroupResource,
    HueResource,
    LightLevelResource,
    LightResource,
    MotionResource,
    RelativeRotaryResource,
    SceneResource,
    SmartSceneResource,
    TamperResource,
    TemperatureResource,
    ZigbeeConnectivityResource,
} from './hue/types';

/** Options which influence which objects are created */
export interface ModelOptions {
    /** Do not create rooms, zones and the "all" group */
    ignoreGroups: boolean;
    /** Do not create scenes and smart scenes */
    ignoreScenes: boolean;
}

interface EntityBase {
    /** ioBroker object id relative to the adapter namespace */
    id: string;
    /** Display name */
    name: string;
    /** Resource ids whose changes influence the states of this entity */
    deps: string[];
}

/** A single light (channel below `lights`) */
export interface LightEntity extends EntityBase {
    /** Discriminator */
    kind: 'light';
    /** Id of the light service */
    lightId: string;
}

/** A room, zone or the "all" group */
export interface GroupEntity extends EntityBase {
    /** Discriminator */
    kind: 'group';
    /** Id of the room, zone or bridge_home */
    groupId: string;
    /** Id of the grouped_light service used for control */
    groupedLightId: string;
}

/** A device with sensor or button services (channel below `sensors`) */
export interface SensorEntity extends EntityBase {
    /** Discriminator */
    kind: 'sensor';
    /** Id of the device */
    deviceId: string;
}

/** A scene (button state below a group) */
export interface SceneEntity extends EntityBase {
    /** Discriminator */
    kind: 'scene';
    /** Id of the scene */
    sceneId: string;
}

/** A smart scene (switch state below a group) */
export interface SmartSceneEntity extends EntityBase {
    /** Discriminator */
    kind: 'smartScene';
    /** Id of the smart scene */
    sceneId: string;
}

/** An entertainment area (switch state below `entertainment`) */
export interface EntertainmentEntity extends EntityBase {
    /** Discriminator */
    kind: 'entertainment';
    /** Id of the entertainment configuration */
    configurationId: string;
}

/** An automation of the Hue app (switch state below `automations`) */
export interface AutomationEntity extends EntityBase {
    /** Discriminator */
    kind: 'automation';
    /** Id of the behavior instance */
    behaviorId: string;
}

/** Everything that can be controlled or observed */
export type Entity =
    LightEntity | GroupEntity | SensorEntity | SceneEntity | SmartSceneEntity | EntertainmentEntity | AutomationEntity;

/** An object which has to exist in the adapter namespace */
export interface ObjectDefinition {
    /** Id relative to the adapter namespace */
    id: string;
    /** The object itself */
    obj: ioBroker.SettableObject;
}

/** Result of {@link buildModel} */
export interface Model {
    /** All objects which have to exist */
    objects: ObjectDefinition[];
    /** All entities with their resource dependencies */
    entities: Entity[];
}

/** State values relative to the adapter namespace */
export type StateValues = Record<string, ioBroker.StateValue>;

/** Service types which make a device appear below `sensors` */
const SENSOR_SERVICE_TYPES = [
    'motion',
    'camera_motion',
    'temperature',
    'light_level',
    'contact',
    'tamper',
    'button',
    'relative_rotary',
];

/** All possible button events */
const BUTTON_EVENTS: ButtonEvent[] = [
    'initial_press',
    'repeat',
    'short_release',
    'long_release',
    'double_short_release',
    'long_press',
];

/** Folders and their display names */
const FOLDERS: Record<string, string> = {
    lights: 'Lights',
    rooms: 'Rooms',
    zones: 'Zones',
    sensors: 'Sensors',
    entertainment: 'Entertainment areas',
    automations: 'Automations',
};

/**
 * Key to identify the object of a resource across restarts
 *
 * @param rtype resource type
 * @param rid resource id
 */
export function resourceKey(rtype: string, rid: string): string {
    return `${rtype}:${rid}`;
}

/**
 * Make a name usable as part of an object id
 *
 * @param name the name
 */
export function sanitizeName(name: string): string {
    const sanitized = name
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '');
    return sanitized || 'unnamed';
}

/**
 * Assigns readable, unique and stable object ids.
 * Existing ids are kept, so renaming a light in the Hue app does not break scripts.
 */
class IdAllocator {
    private readonly reserved = new Map<string, string>();
    private readonly used = new Set<string>();

    /**
     * @param existing map of resource key to existing object id
     * @param activeKeys keys of all resources which still exist
     */
    constructor(
        private readonly existing: Map<string, string>,
        activeKeys: Set<string>,
    ) {
        for (const [key, id] of existing) {
            if (activeKeys.has(key)) {
                this.reserved.set(id, key);
            }
        }
    }

    /**
     * Get the object id for a resource
     *
     * @param prefix parent id
     * @param name display name
     * @param key resource key
     */
    allocate(prefix: string, name: string, key: string): string {
        const existingId = this.existing.get(key);
        if (
            existingId &&
            existingId.startsWith(`${prefix}.`) &&
            !existingId.slice(prefix.length + 1).includes('.') &&
            this.reserved.get(existingId) === key &&
            !this.used.has(existingId)
        ) {
            this.used.add(existingId);
            return existingId;
        }

        const base = `${prefix}.${sanitizeName(name)}`;
        let candidate = base;
        for (let i = 2; this.reserved.has(candidate) || this.used.has(candidate); i++) {
            candidate = `${base}_${i}`;
        }

        this.used.add(candidate);
        return candidate;
    }
}

/**
 * Create a state object definition
 *
 * @param id object id
 * @param common common part of the state
 * @param native native part of the state
 */
function stateObject(
    id: string,
    common: Partial<ioBroker.StateCommon>,
    native: Record<string, unknown> = {},
): ObjectDefinition {
    return {
        id,
        obj: {
            type: 'state',
            common: { read: true, write: false, ...common } as ioBroker.StateCommon,
            native,
        },
    };
}

/**
 * Create a folder or channel object definition
 *
 * @param id object id
 * @param type object type
 * @param name display name
 * @param native native part
 */
function containerObject(
    id: string,
    type: 'folder' | 'channel',
    name: string,
    native: Record<string, unknown> = {},
): ObjectDefinition {
    return { id, obj: { type, common: { name }, native } };
}

/** Capabilities of a light or a group of lights */
interface Capabilities {
    dimming: boolean;
    colorTemperature?: { minKelvin: number; maxKelvin: number };
    color: boolean;
    alert: boolean;
    effects: string[];
}

/**
 * Determine the capabilities of the given lights
 *
 * @param lights the lights
 */
function capabilitiesOf(lights: LightResource[]): Capabilities {
    const caps: Capabilities = { dimming: false, color: false, alert: false, effects: [] };
    let minMirek = Infinity;
    let maxMirek = -Infinity;

    for (const light of lights) {
        caps.dimming ||= !!light.dimming;
        caps.color ||= !!light.color;
        caps.alert ||= !!light.alert?.action_values?.includes('breathe');

        if (light.color_temperature) {
            minMirek = Math.min(minMirek, light.color_temperature.mirek_schema?.mirek_minimum ?? 153);
            maxMirek = Math.max(maxMirek, light.color_temperature.mirek_schema?.mirek_maximum ?? 500);
        }

        for (const effect of light.effects?.effect_values ?? []) {
            if (!caps.effects.includes(effect)) {
                caps.effects.push(effect);
            }
        }
    }

    if (isFinite(minMirek)) {
        caps.colorTemperature = { minKelvin: mirekToKelvin(maxMirek), maxKelvin: mirekToKelvin(minMirek) };
    }

    return caps;
}

/**
 * Create the light control states (shared by lights and groups)
 *
 * @param base channel id
 * @param caps capabilities
 * @param isGroup if this is a group
 */
function lightControlObjects(base: string, caps: Capabilities, isGroup: boolean): ObjectDefinition[] {
    const objs: ObjectDefinition[] = [
        stateObject(`${base}.on`, {
            name: isGroup ? 'Any light on' : 'On',
            type: 'boolean',
            role: 'switch.light',
            write: true,
        }),
    ];

    if (caps.dimming) {
        objs.push(
            stateObject(`${base}.brightness`, {
                name: 'Brightness',
                type: 'number',
                role: 'level.dimmer',
                unit: '%',
                min: 0,
                max: 100,
                write: true,
            }),
        );
    }

    if (caps.colorTemperature) {
        objs.push(
            stateObject(`${base}.colorTemperature`, {
                name: 'Color temperature',
                type: 'number',
                role: 'level.color.temperature',
                unit: 'K',
                min: caps.colorTemperature.minKelvin,
                max: caps.colorTemperature.maxKelvin,
                write: true,
            }),
        );
    }

    if (caps.color) {
        objs.push(
            stateObject(`${base}.xy`, {
                name: 'Color (CIE xy)',
                type: 'string',
                role: 'level.color.xy',
                write: true,
            }),
            stateObject(`${base}.rgb`, {
                name: 'Color (hex)',
                type: 'string',
                role: 'level.color.rgb',
                write: true,
            }),
        );
    }

    if (!isGroup && caps.color && caps.colorTemperature) {
        objs.push(
            stateObject(`${base}.colorMode`, {
                name: 'Color mode',
                type: 'string',
                role: 'text',
                states: { xy: 'xy', ct: 'ct' },
            }),
        );
    }

    if (!isGroup && caps.effects.length) {
        objs.push(
            stateObject(`${base}.effect`, {
                name: 'Effect',
                type: 'string',
                role: 'state',
                states: Object.fromEntries(caps.effects.map(e => [e, e])),
                write: true,
            }),
        );
    }

    if (caps.alert) {
        objs.push(
            stateObject(`${base}.alert`, {
                name: 'Alert (breathe)',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            }),
        );
    }

    objs.push(
        stateObject(`${base}.command`, {
            name: 'Command (JSON)',
            type: 'string',
            role: 'json',
            write: true,
        }),
    );

    return objs;
}

/**
 * Get all lights belonging to a room, zone or the bridge home
 *
 * @param group the group resource
 * @param index resource index
 */
export function membersOf(group: GroupResource, index: ResourceIndex): LightResource[] {
    if (group.type === 'bridge_home') {
        return index.ofType<LightResource>('light');
    }

    const lights = new Map<string, LightResource>();
    for (const child of group.children ?? []) {
        if (child.rtype === 'light') {
            const light = index.get<LightResource>(child.rid);
            if (light) {
                lights.set(light.id, light);
            }
        } else if (child.rtype === 'device') {
            for (const light of index.servicesOf<LightResource>(index.get<DeviceResource>(child.rid), 'light')) {
                lights.set(light.id, light);
            }
        }
    }

    return [...lights.values()];
}

/**
 * Get the grouped_light service of a group
 *
 * @param group the group resource
 * @param index resource index
 */
function groupedLightOf(group: GroupResource, index: ResourceIndex): GroupedLightResource | undefined {
    const service = group.services?.find(s => s.rtype === 'grouped_light');
    return index.get<GroupedLightResource>(service?.rid);
}

/**
 * Build the complete object tree from the resources
 *
 * @param index all resources
 * @param options model options
 * @param existing map of resource key (see {@link resourceKey}) to existing object ids
 */
export function buildModel(index: ResourceIndex, options: ModelOptions, existing = new Map<string, string>()): Model {
    const objects: ObjectDefinition[] = [];
    const entities: Entity[] = [];

    const activeKeys = new Set<string>();
    for (const type of [
        'light',
        'device',
        'room',
        'zone',
        'scene',
        'smart_scene',
        'entertainment_configuration',
        'behavior_instance',
    ]) {
        for (const resource of index.ofType(type)) {
            activeKeys.add(resourceKey(type, resource.id));
        }
    }
    const ids = new IdAllocator(existing, activeKeys);
    const usedFolders = new Set<string>();

    buildLights(index, ids, objects, entities, usedFolders);
    buildSensors(index, ids, objects, entities, usedFolders);

    if (!options.ignoreGroups) {
        buildGroups(index, options, ids, objects, entities, usedFolders);
    }

    buildEntertainment(index, ids, objects, entities, usedFolders);
    buildAutomations(index, ids, objects, entities, usedFolders);

    for (const folder of usedFolders) {
        objects.unshift(containerObject(folder, 'folder', FOLDERS[folder]));
    }

    return { objects, entities };
}

/**
 * Build all light channels
 *
 * @param index all resources
 * @param ids id allocator
 * @param objects object definitions (output)
 * @param entities entities (output)
 * @param folders used top level folders (output)
 */
function buildLights(
    index: ResourceIndex,
    ids: IdAllocator,
    objects: ObjectDefinition[],
    entities: Entity[],
    folders: Set<string>,
): void {
    for (const light of index.ofType<LightResource>('light')) {
        const device = index.deviceOf(light);
        const siblings = index.servicesOf<LightResource>(device, 'light');
        let name = device?.metadata.name ?? light.metadata?.name ?? light.id;
        if (siblings.length > 1) {
            name = `${name} ${siblings.findIndex(s => s.id === light.id) + 1}`;
        }

        const id = ids.allocate('lights', name, resourceKey('light', light.id));
        const connectivity = index.servicesOf(device, 'zigbee_connectivity')[0];

        folders.add('lights');
        objects.push(
            containerObject(id, 'channel', name, {
                id: light.id,
                type: 'light',
                deviceId: device?.id,
                modelId: device?.product_data.model_id,
                productName: device?.product_data.product_name,
                manufacturer: device?.product_data.manufacturer_name,
                softwareVersion: device?.product_data.software_version,
                gamutType: light.color?.gamut_type,
            }),
            ...lightControlObjects(id, capabilitiesOf([light]), false),
        );

        if (connectivity) {
            objects.push(
                stateObject(`${id}.reachable`, { name: 'Reachable', type: 'boolean', role: 'indicator.reachable' }),
            );
        }

        entities.push({
            kind: 'light',
            id,
            name,
            lightId: light.id,
            deps: [light.id, ...(connectivity ? [connectivity.id] : [])],
        });
    }
}

/**
 * Build all sensor channels (one per device with sensor or button services)
 *
 * @param index all resources
 * @param ids id allocator
 * @param objects object definitions (output)
 * @param entities entities (output)
 * @param folders used top level folders (output)
 */
function buildSensors(
    index: ResourceIndex,
    ids: IdAllocator,
    objects: ObjectDefinition[],
    entities: Entity[],
    folders: Set<string>,
): void {
    for (const device of index.ofType<DeviceResource>('device')) {
        if (!device.services.some(s => SENSOR_SERVICE_TYPES.includes(s.rtype))) {
            continue;
        }

        const name = device.metadata.name;
        const id = ids.allocate('sensors', name, resourceKey('device', device.id));
        const has = (rtype: string): boolean => device.services.some(s => s.rtype === rtype);

        folders.add('sensors');
        objects.push(
            containerObject(id, 'channel', name, {
                id: device.id,
                type: 'device',
                modelId: device.product_data.model_id,
                productName: device.product_data.product_name,
                manufacturer: device.product_data.manufacturer_name,
                softwareVersion: device.product_data.software_version,
            }),
        );

        if (has('motion') || has('camera_motion')) {
            objects.push(
                stateObject(`${id}.motion`, { name: 'Motion', type: 'boolean', role: 'sensor.motion' }),
                stateObject(`${id}.motionEnabled`, {
                    name: 'Motion detection enabled',
                    type: 'boolean',
                    role: 'switch.enable',
                    write: true,
                }),
            );
        }
        if (has('temperature')) {
            objects.push(
                stateObject(`${id}.temperature`, {
                    name: 'Temperature',
                    type: 'number',
                    role: 'value.temperature',
                    unit: '°C',
                }),
            );
        }
        if (has('light_level')) {
            objects.push(
                stateObject(`${id}.illuminance`, {
                    name: 'Illuminance',
                    type: 'number',
                    role: 'value.brightness',
                    unit: 'lx',
                }),
            );
        }
        if (has('contact')) {
            objects.push(stateObject(`${id}.open`, { name: 'Open', type: 'boolean', role: 'sensor.door' }));
        }
        if (has('tamper')) {
            objects.push(stateObject(`${id}.tampered`, { name: 'Tampered', type: 'boolean', role: 'sensor.alarm' }));
        }
        if (has('device_power')) {
            objects.push(
                stateObject(`${id}.battery`, {
                    name: 'Battery',
                    type: 'number',
                    role: 'value.battery',
                    unit: '%',
                    min: 0,
                    max: 100,
                }),
                stateObject(`${id}.lowBattery`, { name: 'Low battery', type: 'boolean', role: 'indicator.lowbat' }),
            );
        }
        if (has('zigbee_connectivity')) {
            objects.push(
                stateObject(`${id}.reachable`, { name: 'Reachable', type: 'boolean', role: 'indicator.reachable' }),
            );
        }
        for (const button of index.servicesOf<ButtonResource>(device, 'button')) {
            objects.push(
                stateObject(`${id}.button${button.metadata.control_id}`, {
                    name: `Button ${button.metadata.control_id}`,
                    type: 'string',
                    role: 'text',
                    states: Object.fromEntries(BUTTON_EVENTS.map(e => [e, e])),
                }),
            );
        }
        if (has('relative_rotary')) {
            objects.push(
                stateObject(`${id}.rotary`, {
                    name: 'Rotary steps (negative = counter clockwise)',
                    type: 'number',
                    role: 'value',
                }),
            );
        }

        entities.push({
            kind: 'sensor',
            id,
            name,
            deviceId: device.id,
            deps: device.services.map(s => s.rid),
        });
    }
}

/**
 * Build rooms, zones, the "all" group and their scenes
 *
 * @param index all resources
 * @param options model options
 * @param ids id allocator
 * @param objects object definitions (output)
 * @param entities entities (output)
 * @param folders used top level folders (output)
 */
function buildGroups(
    index: ResourceIndex,
    options: ModelOptions,
    ids: IdAllocator,
    objects: ObjectDefinition[],
    entities: Entity[],
    folders: Set<string>,
): void {
    const groups = [
        ...index.ofType<GroupResource>('room'),
        ...index.ofType<GroupResource>('zone'),
        ...index.ofType<GroupResource>('bridge_home'),
    ];

    for (const group of groups) {
        const groupedLight = groupedLightOf(group, index);
        if (!groupedLight) {
            // groups without lights cannot be controlled
            continue;
        }

        const members = membersOf(group, index);
        const scenes = options.ignoreScenes
            ? []
            : index.ofType<SceneResource>('scene').filter(s => s.group.rid === group.id);
        const smartScenes = options.ignoreScenes
            ? []
            : index.ofType<SmartSceneResource>('smart_scene').filter(s => s.group.rid === group.id);

        let id: string;
        let name: string;
        if (group.type === 'bridge_home') {
            id = 'all';
            name = 'All lights';
        } else {
            const folder = group.type === 'room' ? 'rooms' : 'zones';
            folders.add(folder);
            name = group.metadata?.name ?? group.id;
            id = ids.allocate(folder, name, resourceKey(group.type, group.id));
        }

        objects.push(
            containerObject(id, 'channel', name, {
                id: group.id,
                type: group.type,
                groupedLightId: groupedLight.id,
            }),
            ...lightControlObjects(id, capabilitiesOf(members), true),
            stateObject(`${id}.allOn`, { name: 'All lights on', type: 'boolean', role: 'indicator' }),
        );

        if (scenes.length) {
            objects.push(
                stateObject(`${id}.activeScene`, { name: 'Active scene', type: 'string', role: 'text' }),
                containerObject(`${id}.scenes`, 'folder', 'Scenes'),
            );
        }

        for (const scene of scenes) {
            const sceneId = ids.allocate(`${id}.scenes`, scene.metadata.name, resourceKey('scene', scene.id));
            objects.push(
                stateObject(
                    sceneId,
                    {
                        name: scene.metadata.name,
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                    },
                    { id: scene.id, type: 'scene' },
                ),
            );
            entities.push({
                kind: 'scene',
                id: sceneId,
                name: scene.metadata.name,
                sceneId: scene.id,
                deps: [scene.id],
            });
        }

        if (smartScenes.length) {
            objects.push(containerObject(`${id}.smartScenes`, 'folder', 'Smart scenes'));
        }

        for (const smartScene of smartScenes) {
            const sceneId = ids.allocate(
                `${id}.smartScenes`,
                smartScene.metadata.name,
                resourceKey('smart_scene', smartScene.id),
            );
            objects.push(
                stateObject(
                    sceneId,
                    { name: smartScene.metadata.name, type: 'boolean', role: 'switch', write: true },
                    { id: smartScene.id, type: 'smart_scene' },
                ),
            );
            entities.push({
                kind: 'smartScene',
                id: sceneId,
                name: smartScene.metadata.name,
                sceneId: smartScene.id,
                deps: [smartScene.id],
            });
        }

        entities.push({
            kind: 'group',
            id,
            name,
            groupId: group.id,
            groupedLightId: groupedLight.id,
            deps: [groupedLight.id, ...members.map(l => l.id), ...scenes.map(s => s.id)],
        });
    }
}

/**
 * Build entertainment areas
 *
 * @param index all resources
 * @param ids id allocator
 * @param objects object definitions (output)
 * @param entities entities (output)
 * @param folders used top level folders (output)
 */
function buildEntertainment(
    index: ResourceIndex,
    ids: IdAllocator,
    objects: ObjectDefinition[],
    entities: Entity[],
    folders: Set<string>,
): void {
    for (const config of index.ofType<EntertainmentConfigurationResource>('entertainment_configuration')) {
        const name = config.metadata.name;
        const id = ids.allocate('entertainment', name, resourceKey(config.type, config.id));
        folders.add('entertainment');
        objects.push(
            stateObject(
                id,
                { name: `${name} streaming active`, type: 'boolean', role: 'switch', write: true },
                { id: config.id, type: config.type },
            ),
        );
        entities.push({ kind: 'entertainment', id, name, configurationId: config.id, deps: [config.id] });
    }
}

/**
 * Build automations (behavior instances), which can be enabled or disabled
 *
 * @param index all resources
 * @param ids id allocator
 * @param objects object definitions (output)
 * @param entities entities (output)
 * @param folders used top level folders (output)
 */
function buildAutomations(
    index: ResourceIndex,
    ids: IdAllocator,
    objects: ObjectDefinition[],
    entities: Entity[],
    folders: Set<string>,
): void {
    for (const behavior of index.ofType<BehaviorInstanceResource>('behavior_instance')) {
        const name = behavior.metadata?.name ?? behavior.id;
        const id = ids.allocate('automations', name, resourceKey(behavior.type, behavior.id));
        folders.add('automations');
        objects.push(
            stateObject(
                id,
                { name: `${name} enabled`, type: 'boolean', role: 'switch.enable', write: true },
                { id: behavior.id, type: behavior.type },
            ),
        );
        entities.push({ kind: 'automation', id, name, behaviorId: behavior.id, deps: [behavior.id] });
    }
}

/**
 * Compute the current state values of a light
 *
 * @param entity the light entity
 * @param index all resources
 */
function lightStates(entity: LightEntity, index: ResourceIndex): StateValues {
    const light = index.get<LightResource>(entity.lightId);
    if (!light) {
        return {};
    }

    const base = entity.id;
    const states: StateValues = { [`${base}.on`]: light.on.on };

    if (light.dimming) {
        states[`${base}.brightness`] = Math.round(light.dimming.brightness);
    }

    const ctValid = !!light.color_temperature?.mirek_valid && !!light.color_temperature.mirek;
    if (light.color_temperature && ctValid) {
        states[`${base}.colorTemperature`] = mirekToKelvin(light.color_temperature.mirek!);
    }

    if (light.color) {
        states[`${base}.xy`] = formatXy(light.color.xy);
        states[`${base}.rgb`] = formatHexColor(xyToRgb(light.color.xy));
    }

    if (light.color && light.color_temperature) {
        states[`${base}.colorMode`] = ctValid ? 'ct' : 'xy';
    }

    if (light.effects?.effect_values?.length) {
        states[`${base}.effect`] = light.effects.status ?? light.effects.effect ?? 'no_effect';
    }

    const device = index.deviceOf(light);
    const connectivity = index.servicesOf<ZigbeeConnectivityResource>(device, 'zigbee_connectivity')[0];
    if (connectivity) {
        states[`${base}.reachable`] = connectivity.status === 'connected';
    }

    return states;
}

/**
 * Compute the current state values of a group
 *
 * @param entity the group entity
 * @param index all resources
 */
function groupStates(entity: GroupEntity, index: ResourceIndex): StateValues {
    const groupedLight = index.get<GroupedLightResource>(entity.groupedLightId);
    const group = index.get<GroupResource>(entity.groupId);
    if (!groupedLight || !group) {
        return {};
    }

    const base = entity.id;
    const members = membersOf(group, index);
    const states: StateValues = {
        [`${base}.on`]: !!groupedLight.on?.on,
        [`${base}.allOn`]: members.length > 0 && members.every(l => l.on.on),
    };

    if (groupedLight.dimming && members.some(l => l.dimming)) {
        states[`${base}.brightness`] = Math.round(groupedLight.dimming.brightness);
    }

    const scenes = index.ofType<SceneResource>('scene').filter(s => entity.deps.includes(s.id));
    if (scenes.length) {
        const active = scenes.find(s => s.status?.active && s.status.active !== 'inactive');
        states[`${base}.activeScene`] = active?.metadata.name ?? '';
    }

    return states;
}

/**
 * Compute the current state values of a sensor device (without button and rotary events)
 *
 * @param entity the sensor entity
 * @param index all resources
 */
function sensorStates(entity: SensorEntity, index: ResourceIndex): StateValues {
    const device = index.get<DeviceResource>(entity.deviceId);
    if (!device) {
        return {};
    }

    const base = entity.id;
    const states: StateValues = {};

    const motion =
        index.servicesOf<MotionResource>(device, 'motion')[0] ??
        index.servicesOf<MotionResource>(device, 'camera_motion')[0];
    if (motion) {
        states[`${base}.motionEnabled`] = motion.enabled;
        if (motion.motion.motion_valid !== false) {
            states[`${base}.motion`] = motion.motion.motion_report?.motion ?? !!motion.motion.motion;
        }
    }

    const temperature = index.servicesOf<TemperatureResource>(device, 'temperature')[0];
    if (temperature && temperature.temperature.temperature_valid !== false) {
        const value = temperature.temperature.temperature_report?.temperature ?? temperature.temperature.temperature;
        if (typeof value === 'number') {
            states[`${base}.temperature`] = Math.round(value * 100) / 100;
        }
    }

    const lightLevel = index.servicesOf<LightLevelResource>(device, 'light_level')[0];
    if (lightLevel && lightLevel.light.light_level_valid !== false) {
        const value = lightLevel.light.light_level_report?.light_level ?? lightLevel.light.light_level;
        if (typeof value === 'number') {
            states[`${base}.illuminance`] = lightLevelToLux(value);
        }
    }

    const contact = index.servicesOf<ContactResource>(device, 'contact')[0];
    if (contact?.contact_report) {
        states[`${base}.open`] = contact.contact_report.state === 'no_contact';
    }

    const tamper = index.servicesOf<TamperResource>(device, 'tamper')[0];
    if (tamper) {
        states[`${base}.tampered`] = tamper.tamper_reports.some(r => r.state === 'tampered');
    }

    const power = index.servicesOf<DevicePowerResource>(device, 'device_power')[0];
    if (power?.power_state) {
        if (typeof power.power_state.battery_level === 'number') {
            states[`${base}.battery`] = power.power_state.battery_level;
        }
        if (power.power_state.battery_state) {
            states[`${base}.lowBattery`] = power.power_state.battery_state !== 'normal';
        }
    }

    const connectivity = index.servicesOf<ZigbeeConnectivityResource>(device, 'zigbee_connectivity')[0];
    if (connectivity) {
        states[`${base}.reachable`] = connectivity.status === 'connected';
    }

    return states;
}

/**
 * Compute the current state values of an entity
 *
 * @param entity the entity
 * @param index all resources
 */
export function computeStates(entity: Entity, index: ResourceIndex): StateValues {
    switch (entity.kind) {
        case 'light':
            return lightStates(entity, index);
        case 'group':
            return groupStates(entity, index);
        case 'sensor':
            return sensorStates(entity, index);
        case 'scene':
            return {};
        case 'smartScene': {
            const scene = index.get<SmartSceneResource>(entity.sceneId);
            return scene ? { [entity.id]: scene.state === 'active' } : {};
        }
        case 'entertainment': {
            const config = index.get<EntertainmentConfigurationResource>(entity.configurationId);
            return config ? { [entity.id]: config.status === 'active' } : {};
        }
        case 'automation': {
            const behavior = index.get<BehaviorInstanceResource>(entity.behaviorId);
            return behavior ? { [entity.id]: behavior.enabled } : {};
        }
    }
}

/**
 * Get event-like state values from an update, which have to be set even if the value did not change
 * (e.g. pressing the same button twice)
 *
 * @param entity the sensor entity the update belongs to
 * @param update the update received via the event stream
 * @param index all resources
 */
export function computeEventStates(entity: Entity, update: HueResource, index: ResourceIndex): StateValues {
    if (entity.kind !== 'sensor') {
        return {};
    }

    if (update.type === 'button') {
        const button = index.get<ButtonResource>(update.id);
        const data = (update as ButtonResource).button;
        const event = data?.button_report?.event ?? data?.last_event;
        if (button && event) {
            return { [`${entity.id}.button${button.metadata.control_id}`]: event };
        }
    }

    if (update.type === 'relative_rotary') {
        const data = (update as RelativeRotaryResource).relative_rotary;
        const rotation = (data?.rotary_report ?? data?.last_event)?.rotation;
        if (rotation) {
            const steps = rotation.direction === 'counter_clock_wise' ? -rotation.steps : rotation.steps;
            return { [`${entity.id}.rotary`]: steps };
        }
    }

    return {};
}
