import type { HueV2Client, MotionAreaData, ConvenienceMotionData } from './v2-client';
import type {} from '@iobroker/types';

type Host = Pick<ioBroker.Adapter, 'extendObjectAsync' | 'setStateAsync'>;

/** Read-only MotionAware convenience sensors. Never changes bridge automations. */
export class MotionAreas {
    private areas = new Map<string, MotionAreaData>();
    private sensors = new Map<string, ConvenienceMotionData>();
    private queue: Promise<void> = Promise.resolve();
    private generation = 0;
    private acceptingUpdates = false;

    constructor(
        private host: Host,
        private client: HueV2Client
    ) {}

    /** Serialize snapshots and patches so an older HTTP reply cannot overwrite a push. */
    private enqueue(task: () => Promise<void>): Promise<void> {
        const next = this.queue.then(task);
        this.queue = next.catch(() => undefined);
        return next;
    }

    refresh(): Promise<void> {
        const generation = this.generation;
        return this.enqueue(async () => {
            const [areas, sensors] = await Promise.all([
                this.client.getMotionAreas(),
                this.client.getConvenienceMotion()
            ]);
            if (generation !== this.generation) {
                return;
            }
            for (const id of this.sensors.keys()) {
                if (!sensors.data.some(sensor => sensor.id === id)) {
                    await this.host.setStateAsync(`motionAreas.${id}.valid`, false, true);
                }
            }
            this.areas = new Map(areas.data.map(area => [area.id, area]));
            this.sensors = new Map(sensors.data.map(sensor => [sensor.id, sensor]));
            if (this.sensors.size) {
                await this.host.extendObjectAsync('motionAreas', {
                    type: 'channel',
                    common: { name: 'MotionAware areas' },
                    native: {}
                });
            }
            for (const sensor of this.sensors.values()) {
                const root = `motionAreas.${sensor.id}`;
                await this.host.extendObjectAsync(root, {
                    type: 'channel',
                    common: { name: this.areas.get(sensor.owner.rid)?.name || sensor.id },
                    native: { resourceId: sensor.id, areaId: sensor.owner.rid, type: sensor.type }
                });
                for (const [key, role] of [
                    ['presence', 'sensor.motion'],
                    ['valid', 'indicator'],
                    ['enabled', 'indicator']
                ]) {
                    await this.host.extendObjectAsync(`${root}.${key}`, {
                        type: 'state',
                        common: { name: key, type: 'boolean', role, read: true, write: false },
                        native: {}
                    });
                }
                await this.host.extendObjectAsync(`${root}.lastupdated`, {
                    type: 'state',
                    common: { name: 'Last motion report', type: 'string', role: 'date', read: true, write: false },
                    native: {}
                });
                await this.publish(sensor);
            }
            this.acceptingUpdates = true;
        });
    }

    update(patch: Partial<ConvenienceMotionData> & { id: string }): Promise<void> {
        return this.enqueue(async () => {
            if (!this.acceptingUpdates) {
                return;
            }
            const old = this.sensors.get(patch.id);
            if (!old) {
                return;
            } // New resources are discovered via refresh on add events.
            const sensor = { ...old, ...patch, motion: { ...old.motion, ...patch.motion } };
            this.sensors.set(patch.id, sensor);
            await this.publish(sensor);
        });
    }

    invalidate(): Promise<void> {
        this.generation++;
        this.acceptingUpdates = false;
        return this.enqueue(async () => {
            for (const id of this.sensors.keys()) {
                await this.host.setStateAsync(`motionAreas.${id}.valid`, false, true);
            }
        });
    }

    private async publish(sensor: ConvenienceMotionData): Promise<void> {
        const area = this.areas.get(sensor.owner.rid);
        const enabled = sensor.enabled === true && area?.enabled === true;
        const valid =
            enabled &&
            area?.health === 'healthy' &&
            sensor.motion.motion_valid === true &&
            typeof sensor.motion.motion === 'boolean';
        const root = `motionAreas.${sensor.id}`;
        if (!valid) {
            await this.host.setStateAsync(`${root}.valid`, false, true);
        }
        await this.host.setStateAsync(`${root}.enabled`, enabled, true);
        if (valid && typeof sensor.motion.motion === 'boolean') {
            await this.host.setStateAsync(`${root}.presence`, sensor.motion.motion, true);
        }
        if (sensor.motion.motion_report?.changed) {
            await this.host.setStateAsync(`${root}.lastupdated`, sensor.motion.motion_report.changed, true);
        }
        await this.host.setStateAsync(`${root}.valid`, valid, true);
    }
}
