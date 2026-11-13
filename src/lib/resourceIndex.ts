import { deepMerge } from './hue/commandQueue';
import type { DeviceResource, HueResource } from './hue/types';

/**
 * In-memory copy of all resources of the bridge, kept up to date via the event stream
 */
export class ResourceIndex {
    private readonly resources = new Map<string, HueResource>();

    /**
     * @param resources all resources as returned by the bridge
     */
    constructor(resources: HueResource[] = []) {
        for (const resource of resources) {
            this.resources.set(resource.id, resource);
        }
    }

    /**
     * Get a resource by id
     *
     * @param id the resource id
     */
    get<T extends HueResource = HueResource>(id: string | undefined): T | undefined {
        return id ? (this.resources.get(id) as T | undefined) : undefined;
    }

    /**
     * Get all resources of the given type
     *
     * @param type resource type
     */
    ofType<T extends HueResource = HueResource>(type: string): T[] {
        return [...this.resources.values()].filter(r => r.type === type) as T[];
    }

    /**
     * Get the services of a device with the given type
     *
     * @param device the device
     * @param rtype type of the services
     */
    servicesOf<T extends HueResource = HueResource>(device: DeviceResource | undefined, rtype: string): T[] {
        if (!device) {
            return [];
        }

        return device.services
            .filter(s => s.rtype === rtype)
            .map(s => this.get<T>(s.rid))
            .filter((s): s is T => !!s);
    }

    /**
     * Get the owning device of a service
     *
     * @param resource the service resource
     */
    deviceOf(resource: HueResource | undefined): DeviceResource | undefined {
        return resource?.owner?.rtype === 'device' ? this.get<DeviceResource>(resource.owner.rid) : undefined;
    }

    /**
     * Merge a (partial) update received via the event stream
     *
     * @param update partial resource
     * @returns the updated resource or undefined if unknown
     */
    applyUpdate(update: HueResource): HueResource | undefined {
        const existing = this.resources.get(update.id);
        if (!existing) {
            return undefined;
        }

        deepMerge(existing, structuredClone(update));
        return existing;
    }
}
