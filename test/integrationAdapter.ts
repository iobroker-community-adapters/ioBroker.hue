import path from 'node:path';
import { expect } from 'chai';
import { tests } from '@iobroker/testing';
import { createFixture } from './fixtures';
import { MockBridge } from './integration/mockBridge';

const APP_KEY = 'test-app-key';

/**
 * Wait until a condition is fulfilled
 *
 * @param condition function returning a truthy value when done
 * @param timeout maximum time to wait in ms
 */
async function waitFor<T>(condition: () => Promise<T> | T, timeout = 10_000): Promise<NonNullable<T>> {
    const start = Date.now();
    for (;;) {
        const result = await condition();
        if (result) {
            return result;
        }
        if (Date.now() - start > timeout) {
            throw new Error('Timeout while waiting for condition');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Run tests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Communication with a (simulated) Hue bridge', getHarness => {
            const bridge = new MockBridge(createFixture(), APP_KEY);
            let address: string;
            let harness: ReturnType<typeof getHarness>;

            const getState = (id: string): Promise<ioBroker.State | null> => harness.states.getState(`hue.0.${id}`);
            const getObject = (id: string): Promise<ioBroker.Object | null> => harness.objects.getObject(`hue.0.${id}`);

            before(async function () {
                this.timeout(60_000);
                address = await bridge.start();
                harness = getHarness();

                // an object of the old v1 structure which has to be cleaned up
                await harness.objects.setObject('hue.0.Desk', {
                    type: 'channel',
                    common: { name: 'Desk' },
                    native: { id: '1' },
                });
                await harness.objects.setObject('hue.0.Desk.bri', {
                    type: 'state',
                    common: { name: 'bri', type: 'number', role: 'level.dimmer', read: true, write: true },
                    native: {},
                });

                await harness.changeAdapterConfig('hue', { native: { bridge: address, user: APP_KEY } });
                await harness.startAdapterAndWait(true);
                await waitFor(() => bridge.connectedStreams > 0);
            });

            after(async () => {
                await bridge.stop();
            });

            it('creates objects and initial states', async () => {
                const on = await getObject('lights.Desk.on');
                expect(on?.common).to.include({ role: 'switch.light', type: 'boolean', write: true });

                expect((await getState('lights.Desk.brightness'))?.val).to.equal(50);
                expect((await getState('lights.Desk.colorTemperature'))?.val).to.equal(2732);
                expect((await getState('lights.Hall.reachable'))?.val).to.equal(false);
                expect((await getState('sensors.Door.open'))?.val).to.equal(true);
                expect((await getState('sensors.Corridor_sensor.illuminance'))?.val).to.equal(100);
                expect((await getState('rooms.Living_room.activeScene'))?.val).to.equal('Bright');
                expect((await getState('rooms.Living_room.allOn'))?.val).to.equal(false);
                expect((await getState('info.connection'))?.val).to.equal(true);
            });

            it('deletes objects of the old structure', async () => {
                expect(await getObject('Desk')).to.equal(null);
                expect(await getObject('Desk.bri')).to.equal(null);
            });

            it('sends commands to the bridge and acknowledges them', async () => {
                await harness.states.setState('hue.0.lights.Desk.brightness', { val: 20, ack: false });

                const request = await waitFor(() =>
                    bridge.requests.find(r => r.method === 'PUT' && r.path === '/clip/v2/resource/light/light-desk'),
                );
                expect(request.body).to.deep.equal({ dimming: { brightness: 20 }, on: { on: true } });

                await waitFor(async () => (await getState('lights.Desk.brightness'))?.ack);
                expect((await getState('lights.Desk.brightness'))?.val).to.equal(20);
            });

            it('activates scenes via the command state of a group', async () => {
                await harness.states.setState('hue.0.rooms.Living_room.command', {
                    val: JSON.stringify({ scene: 'Relax', transition: 1000 }),
                    ack: false,
                });

                const request = await waitFor(() =>
                    bridge.requests.find(r => r.path === '/clip/v2/resource/scene/scene-relax'),
                );
                expect(request.body).to.deep.equal({ recall: { action: 'active', duration: 1000 } });
            });

            it('updates states from the event stream', async () => {
                bridge.emit('update', [
                    {
                        id: 'motion-1',
                        type: 'motion',
                        motion: { motion: true, motion_report: { changed: new Date().toISOString(), motion: true } },
                    },
                    { id: 'light-hall', type: 'light', on: { on: true } },
                ]);

                await waitFor(async () => (await getState('sensors.Corridor_sensor.motion'))?.val === true);
                // the group state depends on the member lights
                await waitFor(async () => (await getState('rooms.Living_room.allOn'))?.val === true);
            });

            it('sets button events even if the value does not change', async () => {
                const press = (): void =>
                    bridge.emit('update', [
                        {
                            id: 'btn-2',
                            type: 'button',
                            button: { button_report: { updated: new Date().toISOString(), event: 'short_release' } },
                        },
                    ]);

                press();
                const first = await waitFor(() => getState('sensors.Switch.button2'));
                await new Promise(resolve => setTimeout(resolve, 50));
                press();
                await waitFor(async () => ((await getState('sensors.Switch.button2'))?.ts ?? 0) > first.ts);
            });

            it('removes deleted devices after a resync', async function () {
                this.timeout(20_000);
                bridge.setResources(createFixture().filter(r => !['dev-door', 'contact-1', 'tamper-1'].includes(r.id)));
                bridge.emit('delete', [{ id: 'dev-door', type: 'device' }]);

                await waitFor(async () => (await getObject('sensors.Door')) === null, 15_000);
                expect(await getObject('sensors.Door.open')).to.equal(null);
                expect(await getObject('lights.Desk.on')).to.not.equal(null);
            });

            it('reconnects the event stream and resynchronizes', async function () {
                this.timeout(20_000);
                const fullSyncs = (): number =>
                    bridge.requests.filter(r => r.method === 'GET' && r.path === '/clip/v2/resource').length;
                const syncsBefore = fullSyncs();

                // a change which happens while the adapter is disconnected
                bridge.setResources(
                    createFixture().map(r => (r.id === 'light-desk' ? { ...r, on: { on: false } } : r)),
                );
                bridge.dropStreams();

                await waitFor(() => bridge.connectedStreams > 0, 15_000);
                await waitFor(() => fullSyncs() > syncsBefore, 15_000);
                await waitFor(async () => (await getState('lights.Desk.on'))?.val === false);
                expect((await getState('info.connection'))?.val).to.equal(true);
            });

            it('creates a user when the link button is pressed', async function () {
                this.timeout(20_000);
                await harness.enableSendTo();

                const send = (): Promise<any> =>
                    new Promise(resolve => harness.sendTo('hue.0', 'createUser', { ip: address }, resolve));

                expect(await send()).to.deep.equal({ error: 'Not open' });

                bridge.linkButtonPressed = true;
                expect(await send()).to.deep.equal({ native: { user: APP_KEY }, saveConfig: true });
            });
        });
    },
});
