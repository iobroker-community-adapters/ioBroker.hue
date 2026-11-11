import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { AxiosError } from 'axios';
import { MotionAreas } from '../src/lib/v2/motion-areas';
import { HueV2Client, MotionAreaData, ConvenienceMotionData } from '../src/lib/v2/v2-client';

describe('MotionAware read-only resources', () => {
    function fixture() {
        const states = new Map<string, unknown>();
        const objects = new Map<string, any>();
        const area: MotionAreaData = {
            id: 'area',
            type: 'motion_area_configuration',
            name: 'Test room',
            enabled: true,
            health: 'healthy'
        };
        const sensor: ConvenienceMotionData = {
            id: 'sensor',
            type: 'convenience_area_motion',
            owner: { rid: 'area', rtype: 'motion_area_configuration' },
            enabled: true,
            motion: {
                motion: true,
                motion_valid: true,
                motion_report: { changed: '2026-01-01T12:00:00Z', motion: true }
            }
        };
        const data = { areas: [area], sensors: [sensor] };
        const host = {
            extendObjectAsync: async (id: string, obj: unknown) => {
                objects.set(id, obj);
            },
            setStateAsync: async (id: string, value: unknown, ack: boolean) => {
                assert.equal(ack, true);
                states.set(id, value);
            }
        };
        const client = {
            getMotionAreas: async () => ({ errors: [], data: data.areas }),
            getConvenienceMotion: async () => ({ errors: [], data: data.sensors })
        };
        const manager = new MotionAreas(host as unknown as ioBroker.Adapter, client as unknown as HueV2Client);
        return { manager, data, states, objects, client };
    }

    it('discovers v2-only resources and creates read-only states with a friendly name', async () => {
        const { manager, states, objects } = fixture();
        await manager.refresh();
        assert.equal(objects.get('motionAreas.sensor').common.name, 'Test room');
        assert.equal(objects.get('motionAreas.sensor.presence').common.write, false);
        assert.equal(states.get('motionAreas.sensor.presence'), true);
        assert.equal(states.get('motionAreas.sensor.valid'), true);
        assert.equal(states.get('motionAreas.sensor.lastupdated'), '2026-01-01T12:00:00Z');
    });

    it('merges partial push updates without an id_v1', async () => {
        const { manager, states } = fixture();
        await manager.refresh();
        await manager.update({ id: 'sensor', motion: { motion: false } });
        assert.equal(states.get('motionAreas.sensor.presence'), false);
        assert.equal(states.get('motionAreas.sensor.valid'), true);
    });

    it('does not turn an invalid signal into absence', async () => {
        const { manager, states } = fixture();
        await manager.refresh();
        await manager.update({ id: 'sensor', motion: { motion: false, motion_valid: false } });
        assert.equal(states.get('motionAreas.sensor.valid'), false);
        assert.equal(states.get('motionAreas.sensor.presence'), true);
    });

    for (const reason of ['disabled sensor', 'disabled area', 'unhealthy area', 'missing area']) {
        it(`invalidates ${reason}`, async () => {
            const { manager, states, data } = fixture();
            await manager.refresh();
            if (reason === 'disabled sensor') {
                data.sensors[0].enabled = false;
            }
            if (reason === 'disabled area') {
                data.areas[0].enabled = false;
            }
            if (reason === 'unhealthy area') {
                data.areas[0].health = 'unhealthy';
            }
            if (reason === 'missing area') {
                data.areas = [];
            }
            await manager.refresh();
            assert.equal(states.get('motionAreas.sensor.valid'), false);
            assert.equal(states.get('motionAreas.sensor.presence'), true);
        });
    }

    it('invalidates deleted sensors, preserving old objects for user scripts', async () => {
        const { manager, states, data } = fixture();
        await manager.refresh();
        data.sensors = [];
        await manager.refresh();
        assert.equal(states.get('motionAreas.sensor.valid'), false);
    });

    it('rejects updates while disconnected and recovers from a fresh snapshot', async () => {
        const { manager, states } = fixture();
        await manager.refresh();
        await manager.invalidate();
        await manager.update({ id: 'sensor', motion: { motion: false } });
        assert.equal(states.get('motionAreas.sensor.valid'), false);
        assert.equal(states.get('motionAreas.sensor.presence'), true);
        await manager.refresh();
        assert.equal(states.get('motionAreas.sensor.valid'), true);
    });

    it('does not restore validity from a snapshot requested before disconnect', async () => {
        const { manager, states } = fixture();
        await manager.refresh();
        const refresh = manager.refresh();
        const disconnect = manager.invalidate();
        await Promise.all([refresh, disconnect]);
        assert.equal(states.get('motionAreas.sensor.valid'), false);
    });

    it('serializes a snapshot and a newer push', async () => {
        const { manager, states } = fixture();
        await Promise.all([manager.refresh(), manager.update({ id: 'sensor', motion: { motion: false } })]);
        assert.equal(states.get('motionAreas.sensor.presence'), false);
    });

    it('leaves bridges with no MotionAware resources unchanged', async () => {
        const { manager, data, objects } = fixture();
        data.areas = [];
        data.sensors = [];
        await manager.refresh();
        assert.equal(objects.size, 0);
    });
});

describe('MotionAware HTTP errors', () => {
    for (const status of [404, 401, 500]) {
        it(`handles HTTP ${status} without treating authentication/server failures as an empty list`, async () => {
            const client = new HueV2Client({ user: 'test-key', address: 'bridge.invalid' });
            (client as any).restClient = {
                get: async () => {
                    const error = new AxiosError('Test HTTP failure');
                    error.response = { status } as NonNullable<AxiosError['response']>;
                    throw error;
                }
            };
            if (status === 404) {
                assert.deepEqual(await client.getMotionAreas(), { errors: [], data: [] });
            } else {
                await assert.rejects(client.getMotionAreas());
            }
        });
    }
});
