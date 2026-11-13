/**
 * ioBroker Philips Hue adapter, based on the Hue API v2 (CLIP v2)
 *
 * Copyright (c) 2014-2016 hobbyquaker
 * Copyright (c) 2017-2026 Bluefox, Moritz Heusinger and the ioBroker community
 * Apache License 2.0
 */
import * as utils from '@iobroker/adapter-core';
import { buildCommands, CommandError } from './lib/commands';
import { createUser, HueApiError, HueClient } from './lib/hue/client';
import { CommandQueue } from './lib/hue/commandQueue';
import { discoverViaCloud, discoverViaMdns } from './lib/hue/discovery';
import { HueEventStream } from './lib/hue/eventStream';
import type { HueEvent } from './lib/hue/types';
import { buildModel, computeEventStates, computeStates, resourceKey, type Entity, type Model } from './lib/model';
import { ResourceIndex } from './lib/resourceIndex';

/** Delay before a full resynchronisation after structural changes, to bundle multiple changes */
const RESYNC_DELAY_MS = 2_000;
/** Delay before retrying to connect after a failure */
const RETRY_DELAY_MS = 30_000;
/** Properties of an update which change the object tree and require a full resynchronisation */
const STRUCTURAL_PROPERTIES = ['metadata', 'children', 'services'];
/** Common properties which are maintained by the user and have to survive object updates */
const PRESERVED_COMMON_PROPERTIES = ['custom', 'smartName'];

class Hue extends utils.Adapter {
    private client?: HueClient;
    private eventStream?: HueEventStream;
    private queue?: CommandQueue;

    private index = new ResourceIndex();
    /** Entities by their object id */
    private entities = new Map<string, Entity>();
    /** Entities by the ids of the resources they depend on */
    private entitiesByResource = new Map<string, Entity[]>();

    private syncTimer?: ioBroker.Timeout;
    private eventProcessing = Promise.resolve();
    private syncRunning = false;
    private syncPending = false;

    /**
     * @param options adapter options
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hue' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        if (!this.config.bridge || !this.config.user) {
            this.log.warn('Bridge address or user is not configured - please configure the adapter first');
            return;
        }

        this.client = new HueClient({ address: this.config.bridge, appKey: this.config.user });
        this.queue = new CommandQueue(
            cmd => this.client!.updateResource(cmd.rtype, cmd.rid, cmd.body),
            ms => this.delay(ms),
        );

        this.eventStream = new HueEventStream(this.config.bridge, this.config.user);
        this.eventStream.on('connected', reconnect => {
            this.log.info(`Event stream ${reconnect ? 're' : ''}connected`);
            if (reconnect) {
                // we may have missed events while being disconnected
                this.scheduleSync(0);
            } else {
                void this.setState('info.connection', true, true);
            }
        });
        this.eventStream.on('disconnected', (reason, retryInMs) => {
            this.log.warn(`Event stream disconnected (${reason}), reconnecting in ${Math.round(retryInMs / 1_000)} s`);
            void this.setState('info.connection', false, true);
        });
        this.eventStream.on('events', events => {
            // process events strictly in order, so an older value never overwrites a newer one
            this.eventProcessing = this.eventProcessing
                .then(() => this.handleEvents(events))
                .catch(e => this.log.error(`Could not handle events: ${(e as Error).message}`));
        });

        this.subscribeStates('*');
        this.scheduleSync(0);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback has to be called when cleanup is done
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {
            this.clearTimeout(this.syncTimer);
            this.eventStream?.stop();
            this.queue?.stop();
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }

    /**
     * Schedule a full synchronisation of objects and states with the bridge
     *
     * @param delayMs delay before starting
     */
    private scheduleSync(delayMs = RESYNC_DELAY_MS): void {
        if (this.syncRunning) {
            this.syncPending = true;
            return;
        }

        this.clearTimeout(this.syncTimer);
        this.syncTimer = this.setTimeout(async () => {
            this.syncTimer = undefined;
            this.syncRunning = true;
            let success = false;

            try {
                await this.synchronize();
                success = true;
            } catch (e) {
                await this.setState('info.connection', false, true);
                if (e instanceof HueApiError && (e.status === 401 || e.status === 403)) {
                    this.log.error(e.message);
                } else {
                    this.log.warn(`Could not synchronize with bridge ${this.config.bridge}: ${(e as Error).message}`);
                }
            } finally {
                this.syncRunning = false;
            }

            if (!success) {
                this.scheduleSync(RETRY_DELAY_MS);
            } else if (this.syncPending) {
                this.syncPending = false;
                this.scheduleSync();
            }
        }, delayMs);
    }

    /**
     * Fetch all resources, create/update/delete objects and update all states
     */
    private async synchronize(): Promise<void> {
        const resources = await this.client!.getAllResources();
        this.index = new ResourceIndex(resources);

        const existingObjects = await this.getAdapterObjectsAsync();
        const existingIds = new Map<string, string>();
        for (const obj of Object.values(existingObjects)) {
            if (typeof obj.native?.id === 'string' && typeof obj.native?.type === 'string') {
                existingIds.set(resourceKey(obj.native.type, obj.native.id), this.toRelativeId(obj._id));
            }
        }

        const model = buildModel(
            this.index,
            { ignoreGroups: this.config.ignoreGroups, ignoreScenes: this.config.ignoreScenes },
            existingIds,
        );

        await this.syncObjects(model, existingObjects);
        this.registerEntities(model.entities);

        for (const entity of model.entities) {
            await this.writeStates(computeStates(entity, this.index));
        }

        await this.setState('info.connection', true, true);
        this.log.info(
            `Synchronized ${model.entities.length} entities from ${resources.length} resources of bridge ${this.config.bridge}`,
        );

        this.eventStream?.start();
    }

    /**
     * Create and update the objects of the model and delete objects which do not exist anymore
     *
     * @param model the model
     * @param existingObjects all objects of this adapter instance
     */
    private async syncObjects(model: Model, existingObjects: Record<string, ioBroker.Object>): Promise<void> {
        const desired = new Set<string>();

        for (const { id, obj } of model.objects) {
            const fullId = `${this.namespace}.${id}`;
            desired.add(fullId);
            const existing = existingObjects[fullId];

            const common: Record<string, unknown> = { ...obj.common };
            for (const prop of PRESERVED_COMMON_PROPERTIES) {
                const value = (existing?.common as Record<string, unknown> | undefined)?.[prop];
                if (value !== undefined) {
                    common[prop] = value;
                }
            }
            const target = { ...obj, common } as ioBroker.SettableObject;

            if (
                !existing ||
                existing.type !== target.type ||
                JSON.stringify(existing.common) !== JSON.stringify(target.common) ||
                JSON.stringify(existing.native) !== JSON.stringify(target.native)
            ) {
                await this.setObject(id, target);
            }
        }

        for (const fullId of Object.keys(existingObjects)) {
            const relativeId = this.toRelativeId(fullId);
            if (!desired.has(fullId) && relativeId !== 'info' && !relativeId.startsWith('info.')) {
                this.log.info(`Deleting object "${relativeId}", because it does not exist on the bridge anymore`);
                await this.delObjectAsync(relativeId);
            }
        }
    }

    /**
     * Remember the entities for event and state change handling
     *
     * @param entities all entities
     */
    private registerEntities(entities: Entity[]): void {
        this.entities = new Map(entities.map(e => [e.id, e]));
        this.entitiesByResource = new Map();

        for (const entity of entities) {
            for (const rid of entity.deps) {
                const list = this.entitiesByResource.get(rid) ?? [];
                list.push(entity);
                this.entitiesByResource.set(rid, list);
            }
        }
    }

    /**
     * Write state values (ack) if they changed
     *
     * @param states state values
     * @param force also write unchanged values (for events like button presses)
     */
    private async writeStates(states: Record<string, ioBroker.StateValue>, force = false): Promise<void> {
        for (const [id, val] of Object.entries(states)) {
            try {
                if (force) {
                    await this.setState(id, val, true);
                } else {
                    await this.setStateChangedAsync(id, val, true);
                }
            } catch (e) {
                this.log.warn(`Could not set state "${id}": ${(e as Error).message}`);
            }
        }
    }

    /**
     * Handle events received via the event stream
     *
     * @param events the events
     */
    private async handleEvents(events: HueEvent[]): Promise<void> {
        for (const event of events) {
            if (event.type === 'add' || event.type === 'delete') {
                this.log.debug(`Resources ${event.type === 'add' ? 'added' : 'deleted'}, scheduling resync`);
                this.scheduleSync();
                continue;
            }

            if (event.type !== 'update') {
                continue;
            }

            for (const update of event.data) {
                this.log.debug(`Update: ${JSON.stringify(update)}`);

                if (STRUCTURAL_PROPERTIES.some(prop => prop in update)) {
                    this.scheduleSync();
                }

                if (!this.index.applyUpdate(update)) {
                    continue;
                }

                for (const entity of this.entitiesByResource.get(update.id) ?? []) {
                    await this.writeStates(computeStates(entity, this.index));
                    await this.writeStates(computeEventStates(entity, update, this.index), true);
                }
            }
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id full state id
     * @param state the new state
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.queue) {
            return;
        }

        const relativeId = this.toRelativeId(id);
        const entity =
            this.entities.get(relativeId) ?? this.entities.get(relativeId.slice(0, relativeId.lastIndexOf('.')));
        if (!entity) {
            this.log.warn(`State "${relativeId}" is not known (yet)`);
            return;
        }

        try {
            const commands = buildCommands(entity, relativeId, state.val, this.index, {
                turnOnWithOthers: this.config.turnOnWithOthers,
            });

            if (!commands.length) {
                return;
            }

            this.log.debug(`Sending ${JSON.stringify(commands)}`);
            await Promise.all(commands.map(cmd => this.queue!.enqueue(cmd)));

            // acknowledge the value, unless the event stream already delivered a newer value
            const current = await this.getStateAsync(relativeId);
            if (current && !current.ack && current.val === state.val) {
                await this.setState(relativeId, state.val, true);
            }
        } catch (e) {
            if (e instanceof CommandError) {
                this.log.warn(`Cannot handle "${relativeId}" = ${JSON.stringify(state.val)}: ${e.message}`);
            } else {
                this.log.error(`Could not control "${entity.name}": ${(e as Error).message}`);
            }
        }
    }

    /**
     * Handle messages from the admin UI
     *
     * @param obj the received message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command) {
            return;
        }

        const respond = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };

        switch (obj.command) {
            case 'browse': {
                const timeout = Number((obj.message as Record<string, unknown>)?.timeout) || 5_000;
                const bridges = await this.browse(timeout);
                respond(bridges.map(ip => ({ value: ip, label: ip })));
                break;
            }

            case 'createUser': {
                const rawIp = (obj.message as Record<string, unknown> | undefined)?.ip;
                const ip = typeof rawIp === 'string' ? rawIp.trim() : '';
                if (!ip) {
                    respond({ error: 'No bridge address' });
                    break;
                }

                try {
                    const result = await createUser(ip, 'iobroker#hue');
                    if (result.success) {
                        this.log.info('Created new user on the bridge');
                        respond({ native: { user: result.appKey }, saveConfig: true });
                    } else if (result.linkButtonNotPressed) {
                        respond({ error: 'Not open' });
                    } else {
                        this.log.error(`Could not create user: ${result.message}`);
                        respond({ error: 'Unknown error' });
                    }
                } catch (e) {
                    this.log.error(`Could not create user: ${(e as Error).message}`);
                    respond({ error: 'Unknown error' });
                }
                break;
            }

            default:
                this.log.warn(`Unknown command: ${obj.command}`);
                respond({ error: 'Unknown command' });
        }
    }

    /**
     * Search for bridges via mDNS and the Signify discovery service
     *
     * @param timeout time to wait for answers in ms
     */
    private async browse(timeout: number): Promise<string[]> {
        const results = await Promise.allSettled([discoverViaMdns(timeout), discoverViaCloud(timeout)]);
        const ips = new Set<string>();

        for (const result of results) {
            if (result.status === 'fulfilled') {
                result.value.forEach(ip => ips.add(ip));
            } else {
                this.log.warn(`Bridge discovery failed: ${(result.reason as Error).message}`);
            }
        }

        return [...ips];
    }

    /**
     * Strip the namespace from a full id
     *
     * @param id full object id
     */
    private toRelativeId(id: string): string {
        return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hue(options);
} else {
    // otherwise start the instance directly
    (() => new Hue())();
}
