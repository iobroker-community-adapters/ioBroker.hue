import { expect } from 'chai';
import { buildCommands, CommandError, parseCommand } from '../../src/lib/commands';
import { buildModel, type Entity } from '../../src/lib/model';
import { ResourceIndex } from '../../src/lib/resourceIndex';
import { createFixture } from '../fixtures';

describe('commands', () => {
    const index = new ResourceIndex(createFixture());
    const model = buildModel(index, { ignoreGroups: false, ignoreScenes: false });
    const entity = (id: string): Entity => model.entities.find(e => e.id === id)!;
    const options = { turnOnWithOthers: true };

    const build = (
        entityId: string,
        state: string,
        value: ioBroker.StateValue,
        opts = options,
    ): ReturnType<typeof buildCommands> => buildCommands(entity(entityId), state, value, index, opts);

    it('switches a light on and off', () => {
        expect(build('lights.Desk', 'lights.Desk.on', false)).to.deep.equal([
            { rtype: 'light', rid: 'light-desk', body: { on: { on: false } } },
        ]);
        expect(build('lights.Desk', 'lights.Desk.on', 'true')).to.deep.equal([
            { rtype: 'light', rid: 'light-desk', body: { on: { on: true } } },
        ]);
    });

    it('turns the light on with brightness and off with brightness 0', () => {
        expect(build('lights.Desk', 'lights.Desk.brightness', 40)[0].body).to.deep.equal({
            dimming: { brightness: 40 },
            on: { on: true },
        });
        expect(build('lights.Desk', 'lights.Desk.brightness', 0)[0].body).to.deep.equal({ on: { on: false } });
        expect(build('lights.Desk', 'lights.Desk.brightness', 150)[0].body).to.deep.include({
            dimming: { brightness: 100 },
        });
    });

    it('converts and clamps the color temperature', () => {
        expect(build('lights.Desk', 'lights.Desk.colorTemperature', 4000)[0].body).to.deep.equal({
            color_temperature: { mirek: 250 },
            on: { on: true },
        });
        // 10000 K is below the minimum of 153 mirek
        expect(build('lights.Desk', 'lights.Desk.colorTemperature', 10000)[0].body).to.deep.include({
            color_temperature: { mirek: 153 },
        });
    });

    it('does not turn the light on with color if turnOnWithOthers is disabled', () => {
        expect(
            build('lights.Desk', 'lights.Desk.colorTemperature', 4000, { turnOnWithOthers: false })[0].body,
        ).to.deep.equal({ color_temperature: { mirek: 250 } });
    });

    it('converts rgb into a color point inside the gamut', () => {
        const body = build('lights.Desk', 'lights.Desk.rgb', '#00FF00')[0].body as {
            color: { xy: { x: number; y: number } };
        };
        // pure green is outside gamut C and has to be moved onto the gamut edge
        expect(body.color.xy.x).to.be.within(0.17, 0.25);
        expect(body.color.xy.y).to.be.within(0.6, 0.7);

        expect(() => build('lights.Desk', 'lights.Desk.rgb', '#000000')).to.throw(CommandError);
        expect(() => build('lights.Desk', 'lights.Desk.rgb', 'green')).to.throw(CommandError, /#RRGGBB/);
    });

    it('validates xy values', () => {
        expect(build('lights.Desk', 'lights.Desk.xy', '0.3,0.3')[0].body).to.deep.include({
            color: { xy: { x: 0.3, y: 0.3 } },
        });
        expect(() => build('lights.Desk', 'lights.Desk.xy', '2,0')).to.throw(CommandError);
    });

    it('validates effects', () => {
        expect(build('lights.Desk', 'lights.Desk.effect', 'candle')[0].body).to.deep.equal({
            effects: { effect: 'candle' },
            on: { on: true },
        });
        expect(build('lights.Desk', 'lights.Desk.effect', 'no_effect')[0].body).to.deep.equal({
            effects: { effect: 'no_effect' },
        });
        expect(() => build('lights.Desk', 'lights.Desk.effect', 'sparkle')).to.throw(CommandError, /not supported/);
    });

    it('rejects unsupported features', () => {
        expect(() => build('lights.Hall', 'lights.Hall.command', '{"rgb":"#FF0000"}')).to.throw(
            CommandError,
            /Color is not supported/,
        );
        expect(() => build('lights.Desk', 'lights.Desk.reachable', true)).to.throw(CommandError, /read-only/);
    });

    it('handles alert buttons', () => {
        expect(build('lights.Desk', 'lights.Desk.alert', true)[0].body).to.deep.equal({ alert: { action: 'breathe' } });
        expect(build('lights.Desk', 'lights.Desk.alert', false)).to.deep.equal([]);
    });

    it('combines multiple properties of a command with a transition', () => {
        expect(
            build(
                'lights.Desk',
                'lights.Desk.command',
                '{"brightness": 30, "colorTemperature": 2700, "transition": 2000}',
            )[0].body,
        ).to.deep.equal({
            dimming: { brightness: 30 },
            color_temperature: { mirek: 370 },
            on: { on: true },
            dynamics: { duration: 2000 },
        });

        // explicit "on" wins over the implicit turn on
        expect(
            build('lights.Desk', 'lights.Desk.command', { on: false, xy: '0.3,0.3' } as any)[0].body,
        ).to.deep.include({
            on: { on: false },
        });
    });

    it('rejects invalid commands', () => {
        expect(() => parseCommand('{invalid')).to.throw(CommandError, /JSON/);
        expect(() => parseCommand('[1,2]')).to.throw(CommandError);
        expect(() => parseCommand('{"bri": 254}')).to.throw(CommandError, /Unsupported command key/);
    });

    it('controls groups via grouped_light', () => {
        expect(build('rooms.Living_room', 'rooms.Living_room.on', false)).to.deep.equal([
            { rtype: 'grouped_light', rid: 'gl-living', body: { on: { on: false } } },
        ]);
        expect(() => build('rooms.Living_room', 'rooms.Living_room.command', '{"effect": "candle"}')).to.throw(
            CommandError,
            /groups/,
        );
    });

    it('recalls scenes via command with transition and brightness', () => {
        expect(
            build(
                'rooms.Living_room',
                'rooms.Living_room.command',
                '{"scene": "relax", "transition": 3000, "brightness": 60}',
            ),
        ).to.deep.equal([
            {
                rtype: 'scene',
                rid: 'scene-relax',
                body: { recall: { action: 'active', duration: 3000, dimming: { brightness: 60 } } },
            },
        ]);
        expect(() => build('rooms.Living_room', 'rooms.Living_room.command', '{"scene": "unknown"}')).to.throw(
            CommandError,
            /not found/,
        );
        expect(() => build('lights.Desk', 'lights.Desk.command', '{"scene": "Relax"}')).to.throw(CommandError);
    });

    it('controls scenes, smart scenes, entertainment areas, automations and sensors', () => {
        expect(build('rooms.Living_room.scenes.Bright', 'rooms.Living_room.scenes.Bright', true)).to.deep.equal([
            { rtype: 'scene', rid: 'scene-bright', body: { recall: { action: 'active' } } },
        ]);
        expect(
            build('rooms.Living_room.smartScenes.Natural_light', 'rooms.Living_room.smartScenes.Natural_light', false),
        ).to.deep.equal([{ rtype: 'smart_scene', rid: 'smart-1', body: { recall: { action: 'deactivate' } } }]);
        expect(build('entertainment.TV_area', 'entertainment.TV_area', true)).to.deep.equal([
            { rtype: 'entertainment_configuration', rid: 'ent-1', body: { action: 'start' } },
        ]);
        expect(build('automations.Wake_up', 'automations.Wake_up', false)).to.deep.equal([
            { rtype: 'behavior_instance', rid: 'behavior-1', body: { enabled: false } },
        ]);
        expect(build('sensors.Corridor_sensor', 'sensors.Corridor_sensor.motionEnabled', false)).to.deep.equal([
            { rtype: 'motion', rid: 'motion-1', body: { enabled: false } },
        ]);
        expect(() => build('sensors.Corridor_sensor', 'sensors.Corridor_sensor.temperature', 20)).to.throw(
            CommandError,
        );
    });
});
