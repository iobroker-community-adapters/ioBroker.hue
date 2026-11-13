import { expect } from 'chai';
import {
    buildModel,
    computeEventStates,
    computeStates,
    resourceKey,
    sanitizeName,
    type StateValues,
} from '../../src/lib/model';
import { ResourceIndex } from '../../src/lib/resourceIndex';
import { createFixture } from '../fixtures';

const defaultOptions = { ignoreGroups: false, ignoreScenes: false };

describe('model', () => {
    it('sanitizes names for object ids', () => {
        expect(sanitizeName('Living room')).to.equal('Living_room');
        expect(sanitizeName('Küche.Decke (2)')).to.equal('Küche_Decke_2');
        expect(sanitizeName('...')).to.equal('unnamed');
    });

    it('creates the expected object tree', () => {
        const model = buildModel(new ResourceIndex(createFixture()), defaultOptions);
        const ids = model.objects.map(o => o.id);

        expect(ids).to.include.members([
            'lights',
            'lights.Desk',
            'lights.Desk.on',
            'lights.Desk.brightness',
            'lights.Desk.colorTemperature',
            'lights.Desk.xy',
            'lights.Desk.rgb',
            'lights.Desk.colorMode',
            'lights.Desk.effect',
            'lights.Desk.alert',
            'lights.Desk.command',
            'lights.Desk.reachable',
            'lights.Hall.brightness',
            'sensors.Switch.button1',
            'sensors.Switch.button4',
            'sensors.Switch.battery',
            'sensors.Switch.lowBattery',
            'sensors.Corridor_sensor.motion',
            'sensors.Corridor_sensor.motionEnabled',
            'sensors.Corridor_sensor.temperature',
            'sensors.Corridor_sensor.illuminance',
            'sensors.Door.open',
            'sensors.Door.tampered',
            'sensors.Dial.rotary',
            'rooms.Living_room.on',
            'rooms.Living_room.allOn',
            'rooms.Living_room.activeScene',
            'rooms.Living_room.scenes.Bright',
            'rooms.Living_room.smartScenes.Natural_light',
            'zones.Work.on',
            'all.on',
            'entertainment.TV_area',
            'automations.Wake_up',
        ]);

        // white lights have no color states
        expect(ids).to.not.include('lights.Hall.rgb');
        expect(ids).to.not.include('lights.Hall.colorTemperature');
        // only devices with sensor services are sensors
        expect(ids).to.not.include('sensors.Desk');
        // groups can not have effects
        expect(ids).to.not.include('rooms.Living_room.effect');

        // color temperature range is derived from the mirek schema
        const ct = model.objects.find(o => o.id === 'lights.Desk.colorTemperature')!.obj as ioBroker.StateObject;
        expect(ct.common.min).to.equal(2000);
        expect(ct.common.max).to.equal(6536);

        // folders come first so they exist before their children
        expect(model.objects[0].obj.type).to.equal('folder');
    });

    it('respects ignoreGroups and ignoreScenes', () => {
        const index = new ResourceIndex(createFixture());

        const noScenes = buildModel(index, { ignoreGroups: false, ignoreScenes: true }).objects.map(o => o.id);
        expect(noScenes).to.include('rooms.Living_room.on');
        expect(noScenes.some(id => id.includes('scenes'))).to.equal(false);
        expect(noScenes).to.not.include('rooms.Living_room.activeScene');

        const noGroups = buildModel(index, { ignoreGroups: true, ignoreScenes: false }).objects.map(o => o.id);
        expect(noGroups.some(id => id.startsWith('rooms') || id.startsWith('zones') || id.startsWith('all'))).to.equal(
            false,
        );
    });

    it('keeps existing object ids when a resource is renamed', () => {
        const resources = createFixture();
        const desk = resources.find(r => r.id === 'dev-desk')!;
        (desk.metadata as { name: string }).name = 'Desk lamp';

        const existing = new Map([[resourceKey('light', 'light-desk'), 'lights.Desk']]);
        const model = buildModel(new ResourceIndex(resources), defaultOptions, existing);

        const light = model.entities.find(e => e.kind === 'light' && e.lightId === 'light-desk')!;
        expect(light.id).to.equal('lights.Desk');
        expect(light.name).to.equal('Desk lamp');
    });

    it('does not let a new resource take the id of an existing one', () => {
        const resources = createFixture();
        // the hall light is now also called "Desk", but the original desk keeps its id
        (resources.find(r => r.id === 'dev-hall')!.metadata as { name: string }).name = 'Desk';

        const existing = new Map([[resourceKey('light', 'light-desk'), 'lights.Desk']]);
        const model = buildModel(new ResourceIndex(resources), defaultOptions, existing);

        const ids = model.entities.filter(e => e.kind === 'light').map(e => e.id);
        expect(ids).to.have.members(['lights.Desk', 'lights.Desk_2']);
        expect(model.entities.find(e => e.kind === 'light' && e.lightId === 'light-desk')!.id).to.equal('lights.Desk');
    });

    it('computes light states', () => {
        const index = new ResourceIndex(createFixture());
        const model = buildModel(index, defaultOptions);
        const desk = model.entities.find(e => e.id === 'lights.Desk')!;
        const hall = model.entities.find(e => e.id === 'lights.Hall')!;

        expect(computeStates(desk, index)).to.deep.equal({
            'lights.Desk.on': true,
            'lights.Desk.brightness': 50,
            'lights.Desk.colorTemperature': 2732,
            'lights.Desk.xy': '0.4573,0.41',
            'lights.Desk.rgb': computeStates(desk, index)['lights.Desk.rgb'],
            'lights.Desk.colorMode': 'ct',
            'lights.Desk.effect': 'no_effect',
            'lights.Desk.reachable': true,
        });
        expect(computeStates(desk, index)['lights.Desk.rgb']).to.match(/^#[0-9A-F]{6}$/);

        expect(computeStates(hall, index)).to.deep.equal({
            'lights.Hall.on': false,
            'lights.Hall.brightness': 100,
            'lights.Hall.reachable': false,
        });
    });

    it('computes group states including allOn and the active scene', () => {
        const index = new ResourceIndex(createFixture());
        const model = buildModel(index, defaultOptions);
        const room = model.entities.find(e => e.id === 'rooms.Living_room')!;
        const zone = model.entities.find(e => e.id === 'zones.Work')!;
        const all = model.entities.find(e => e.id === 'all')!;

        expect(computeStates(room, index)).to.deep.equal({
            'rooms.Living_room.on': true,
            'rooms.Living_room.allOn': false,
            'rooms.Living_room.brightness': 75,
            'rooms.Living_room.activeScene': 'Bright',
        });
        expect(computeStates(zone, index)).to.include({ 'zones.Work.allOn': true });
        expect(computeStates(all, index)).to.include({ 'all.on': true, 'all.allOn': false });

        // a light update changes the allOn state of its groups
        expect(room.deps).to.include('light-hall');
        index.applyUpdate({ id: 'light-hall', type: 'light', on: { on: true } });
        expect(computeStates(room, index)['rooms.Living_room.allOn']).to.equal(true);
    });

    it('computes sensor states', () => {
        const index = new ResourceIndex(createFixture());
        const model = buildModel(index, defaultOptions);
        const state = (id: string): StateValues =>
            computeStates(
                model.entities.find(e => e.id === id)!,
                index,
            );

        expect(state('sensors.Corridor_sensor')).to.deep.equal({
            'sensors.Corridor_sensor.motion': false,
            'sensors.Corridor_sensor.motionEnabled': true,
            'sensors.Corridor_sensor.temperature': 21.37,
            'sensors.Corridor_sensor.illuminance': 100,
            'sensors.Corridor_sensor.battery': 87,
            'sensors.Corridor_sensor.lowBattery': false,
        });
        expect(state('sensors.Switch')).to.deep.equal({
            'sensors.Switch.battery': 12,
            'sensors.Switch.lowBattery': true,
            'sensors.Switch.reachable': true,
        });
        expect(state('sensors.Door')).to.deep.equal({
            'sensors.Door.open': true,
            'sensors.Door.tampered': false,
        });
    });

    it('computes states of scenes, entertainment areas and automations', () => {
        const index = new ResourceIndex(createFixture());
        const model = buildModel(index, defaultOptions);
        const state = (id: string): StateValues =>
            computeStates(
                model.entities.find(e => e.id === id)!,
                index,
            );

        expect(state('rooms.Living_room.smartScenes.Natural_light')).to.deep.equal({
            'rooms.Living_room.smartScenes.Natural_light': false,
        });
        expect(state('entertainment.TV_area')).to.deep.equal({ 'entertainment.TV_area': false });
        expect(state('automations.Wake_up')).to.deep.equal({ 'automations.Wake_up': true });
    });

    it('creates event states for buttons and rotaries', () => {
        const index = new ResourceIndex(createFixture());
        const model = buildModel(index, defaultOptions);
        const sw = model.entities.find(e => e.id === 'sensors.Switch')!;
        const dial = model.entities.find(e => e.id === 'sensors.Dial')!;

        const buttonUpdate = {
            id: 'btn-3',
            type: 'button',
            button: { button_report: { updated: '2026-11-13T10:00:00.000Z', event: 'long_press' } },
        };
        index.applyUpdate(buttonUpdate);
        expect(computeEventStates(sw, buttonUpdate, index)).to.deep.equal({ 'sensors.Switch.button3': 'long_press' });

        const rotaryUpdate = {
            id: 'rotary-1',
            type: 'relative_rotary',
            relative_rotary: {
                rotary_report: {
                    updated: '2026-11-13T10:00:00.000Z',
                    action: 'repeat',
                    rotation: { direction: 'counter_clock_wise', steps: 30, duration: 400 },
                },
            },
        };
        expect(computeEventStates(dial, rotaryUpdate, index)).to.deep.equal({ 'sensors.Dial.rotary': -30 });

        // other updates do not produce events
        expect(computeEventStates(sw, { id: 'pow-switch', type: 'device_power' }, index)).to.deep.equal({});
    });
});
