/**
 *
 *      ioBroker Philips Hue Bridge Adapter
 *
 *      Copyright (c) 2017-2023 Bluefox <dogafox@gmail.com>
 *      Copyright (c) 2014-2016 hobbyquaker
 *      Apache License
 *
 */
import { v3 } from 'node-hue-api';
import * as utils from '@iobroker/adapter-core';
import * as hueHelper from './lib/hueHelper';
import * as tools from './lib/tools';
import Api from 'node-hue-api/lib/api/Api';
import GroupState from 'node-hue-api/lib/model/lightstate/GroupState';
import HuePushClient from 'hue-push-client';
import {
    BatteryState,
    ContactReport,
    ContactSensorData,
    HueUuid,
    HueV2Client,
    Resource,
    Response,
    RoomData,
    SmartSceneData,
    TamperReport,
    TamperState,
    ZoneData
} from './lib/v2/v2-client';
import { MAX_CT, MIN_CT } from './lib/constants';

interface PollSensor {
    /** Sensor id in Hue */
    id: string;
    /** ioBroker channel name */
    name: string;
    /** Sensor name */
    sname: string;
}

interface PollLight {
    /** Light id in Hue */
    id: string;
    /** ioBroker channel name */
    name: string;
}

type ZigbeeConnectivityStatus = 'connected' | 'connectivity_issue';
type StreamingStatus = 'active' | 'inactive';
type ScenceStatus = { active: 'static' | 'inactive' };
type ButtonEventType = 'short_release' | 'initial_press' | 'repeat' | 'long_release';
type RelativeRotaryAction = 'start' | 'repeat';
type RelativeRotaryDirection = 'clock_wise' | 'counter_clock_wise';
interface BridgeUpdate {
    dimming?: { brightness: number };
    /** The UUID which is used by Hue API v2 */
    id: string;
    /** The old Hue API v1 id */
    id_v1?: `/${string}/${number}`;
    owner: Resource;
    type:
        | 'grouped_light'
        | 'light'
        | 'temperature'
        | 'motion'
        | 'light_level'
        | 'zigbee_connectivity'
        | 'device_power'
        | 'entertainment_configuration'
        | 'scene'
        | 'button'
        | 'relative_rotary'
        | 'contact'
        | 'tamper';
    /** if a type is motion */
    motion?: { motion: boolean; motion_report: { changed: string; motion: boolean }; motion_valid: boolean };
    /** if type entertainment_configuration */
    active_streamer?: { rid: 'fa2b6425-206c-40b0-82bc-2fd85d5422d0'; rtype: 'auth_v1' };
    /** if type is contact */
    contact_report?: ContactReport;
    /** for lights and groups */
    on?: { on: boolean };
    color: { xy: { x: number; y: number } };
    /** mirek is null if invalid */
    color_temperature?: { mirek: null | number; mirek_valid: boolean };
    temperature?: {
        temperature: number;
        temperature_report: { changed: string; temperature: number };
        temperature_valid: boolean;
    };
    light?: {
        light_level: number;
        light_level_report: { changed: string; light_level: number };
        light_level_valid: boolean;
    };
    /** For type zigbee_connectivity or entertainment_configuration or scene */
    status?: ZigbeeConnectivityStatus | StreamingStatus | ScenceStatus;
    /** For type device_power */
    power_state?: { battery_level: number; battery_state: BatteryState };
    /** For type button */
    button?: {
        button_report?: { event: ButtonEventType; updated: string };
        last_event: ButtonEventType;
    };
    /** For type relative_rotary */
    relative_rotary?: {
        last_event: {
            action: RelativeRotaryAction;
            rotation: { direction: RelativeRotaryDirection; duration: number; steps: number };
        };
        rotary_report: {
            action: RelativeRotaryAction;
            rotation: { direction: RelativeRotaryDirection; duration: number; steps: number };
            updated: string;
        };
    };
    /** If type is `tamper` */
    tamper_reports?: TamperReport[];
}

/** IDs currently blocked from polling */
const blockedIds: Record<string, boolean> = {};
/** Map ioBroker channel to light id */
const channelIds: Record<string, string> = {};
/** Map ioBroker group name to group id */
const groupIds: Record<string, string> = {};
/** Existing lights on API */
const pollLights: PollLight[] = [];
/** Existing sensors on API */
const pollSensors: PollSensor[] = [];
/** Existing groups on API */
const pollGroups: PollLight[] = [];

let noDevices: number;

const SUPPORTED_SENSORS = [
    'ZLLSwitch',
    'ZGPSwitch',
    'Daylight',
    'ZLLTemperature',
    'ZLLPresence',
    'ZLLLightLevel',
    'ZLLRelativeRotary'
];
const SOFTWARE_SENSORS = ['CLIPGenericStatus', 'CLIPGenericFlag'];

class Hue extends utils.Adapter {
    /** Timeout for next polling */
    private pollingInterval?: ioBroker.Timeout;
    /** Timeout for reconnecting */
    private reconnectTimeout?: ioBroker.Timeout;

    /** Instance of the Hue API */
    private api!: Api;
    /** Instance of the V2 API */
    private clientV2!: InstanceType<typeof HueV2Client>;
    /** Instance of the Hue push client */
    private pushClient: any;
    /** Object which contains all UUIDs and the corresponding metadata */
    private UUIDs: Record<string, any> = {};

    /** Time to wait before between setting and polling group state */
    private GROUP_UPDATE_DELAY_MS = 150;

    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hue' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady(): Promise<void> {
        this.subscribeStates('*');
        this.config.port = this.config.port ? Math.round(this.config.port) : 80;

        if (this.config.syncSoftwareSensors) {
            for (const softwareSensor of SOFTWARE_SENSORS) {
                SUPPORTED_SENSORS.push(softwareSensor);
            }
        }

        // polling interval has to be greater equal 2
        this.config.pollingInterval =
            Math.round(this.config.pollingInterval) < 2 ? 2 : Math.round(this.config.pollingInterval);

        if (!this.config.bridge) {
            this.log.warn(`No bridge configured yet - please configure the adapter first`);
            return;
        }

        await this.connect();

        if (this.config.ssl) {
            this.clientV2 = new HueV2Client({ user: this.config.user, address: this.config.bridge });

            try {
                await this.syncSmartScenes();
            } catch (e: any) {
                this.log.warn(`Could not create smart scenes: ${e.message}`);
            }

            try {
                await this.syncContactSensors();
            } catch (e: any) {
                this.log.warn(`Could not create contact scenes: ${e.message}`);
            }
        }

        if (this.config.polling) {
            this.poll();
        }
    }

    /**
     * Creates contact sensors and deletes no longer existing ones
     */
    private async syncContactSensors(): Promise<void> {
        const contactSensors = await this.clientV2.getContactSensors();

        const res = await this.getObjectViewAsync('system', 'state', {
            startkey: this.namespace,
            endkey: `${this.namespace}\u9999`
        });

        for (const row of res.rows) {
            if (row.value.native?.data?.type !== 'contact') {
                continue;
            }

            const contactData = row.value.native.data as ContactSensorData;
            const contactSensorId = contactData.id;
            const sensorExistsInBridge = contactSensors.data.some(
                contactSensor => contactSensor.id === contactSensorId
            );

            if (!sensorExistsInBridge) {
                const deviceId = contactData.owner.rid;
                this.log.info(`Deleted contact sensor "${deviceId}"`);
                await this.delObjectAsync(deviceId, { recursive: true });
            }
        }

        for (const contactSensor of contactSensors.data) {
            const deviceId = contactSensor.owner.rid;
            const device = await this.clientV2.getDevice(deviceId);
            const deviceData = device.data[0];

            await this.extendObjectAsync(deviceId, {
                type: 'device',
                common: {
                    name: deviceData.metadata.name
                },
                native: {
                    data: deviceData
                }
            });

            await this.extendObjectAsync(`${deviceId}.${contactSensor.id}`, {
                type: 'state',
                common: {
                    name: 'Contact State',
                    type: 'boolean',
                    role: 'sensor.contact',
                    write: false,
                    read: true
                },
                native: {
                    data: contactSensor
                }
            });

            await this.setStateAsync(
                `${deviceId}.${contactSensor.id}`,
                this.contactToStateVal(contactSensor.contact_report.state),
                true
            );

            for (const service of deviceData.services) {
                await this.createService(deviceId, service);
            }
        }
    }

    /**
     * Create state for given service
     *
     * @param deviceId id of the device
     * @param resource the resource to create a state for
     */
    private async createService(deviceId: HueUuid, resource: Resource): Promise<void> {
        if (resource.rtype === 'device_power') {
            const devicePowerResponse = await this.clientV2.getDevicePower(resource.rid);
            const devicePowerData = devicePowerResponse.data[0];

            await this.extendObjectAsync(`${deviceId}.${resource.rid}`, {
                type: 'state',
                common: {
                    name: 'Battery Level',
                    type: 'number',
                    role: 'value.battery',
                    write: false,
                    read: true,
                    unit: '%'
                },
                native: {
                    data: devicePowerData
                }
            });

            await this.setStateAsync(`${deviceId}.${resource.rid}`, devicePowerData.power_state.battery_level, true);
            return;
        }

        if (resource.rtype === 'tamper') {
            const tamperStateResponse = await this.clientV2.getTamperState(resource.rid);
            const tamperData = tamperStateResponse.data[0];

            await this.extendObjectAsync(`${deviceId}.${resource.rid}`, {
                type: 'state',
                common: {
                    name: 'Tamper Alarm',
                    type: 'boolean',
                    role: 'sensor.alarm',
                    write: false,
                    read: true,
                    def: false
                },
                native: {
                    data: tamperData
                }
            });

            if (tamperData.tamper_reports.length > 0) {
                await this.setStateAsync(
                    `${deviceId}.${resource.rid}`,
                    this.tamperToStateVal(tamperData.tamper_reports[0].state),
                    true
                );
            }
            return;
        }

        this.log.debug(`Do not create service for "${resource.rtype}"`);
    }

    /**
     * Convert contact sensor string to boolean (note, that open means true)
     *
     * @param contactState contact state from HUE API
     */
    private contactToStateVal(contactState: ContactReport['state']): boolean {
        return contactState === 'no_contact';
    }

    /**
     * Convert tamper state to ioBroker state value, true means tampered
     *
     * @param tamperState tamper state from HUE API
     */
    private tamperToStateVal(tamperState: TamperState): boolean {
        return tamperState === 'tampered';
    }

    /**
     * Creates smart scenes for existing groups and deletes no longer existing ones
     */
    private async syncSmartScenes(): Promise<void> {
        const scenesData = await this.clientV2.getSmartScenes();
        const res = await this.getObjectViewAsync('system', 'state', {
            startkey: this.namespace,
            endkey: `${this.namespace}\u9999`
        });

        for (const row of res.rows) {
            if (row.value.native?.data?.type !== 'smart_scene') {
                continue;
            }

            const smartSceneId = (row.value.native.data as SmartSceneData).id;
            const sceneExistsInBridge = scenesData.data.some(smartScene => smartScene.id === smartSceneId);

            if (!sceneExistsInBridge) {
                this.log.info(`Deleted smart scene "${smartSceneId}"`);
                const groupUuid = (row.value.native.data as SmartSceneData).group.rid;
                await this.delObjectAsync(`${groupUuid}.${smartSceneId}`);

                // check if group is now empty
                const res = await this.getObjectViewAsync('system', 'state', {
                    startkey: `${this.namespace}.${groupUuid}.`,
                    endkey: `${this.namespace}.${groupUuid}.\u9999`
                });

                if (res.rows.length === 0) {
                    await this.delObjectAsync(groupUuid);
                }
            }
        }

        for (const sceneData of scenesData.data) {
            const groupUuid = sceneData.group.rid;
            const isGroup = sceneData.group.rtype === 'room';

            let groupOrZoneData: Response<RoomData | ZoneData>;

            if (isGroup) {
                groupOrZoneData = await this.clientV2.getRoom(groupUuid);
            } else {
                groupOrZoneData = await this.clientV2.getZone(groupUuid);
            }

            await this.extendObjectAsync(groupUuid, {
                type: 'channel',
                common: {
                    name: groupOrZoneData.data[0].metadata.name
                },
                native: {
                    data: groupOrZoneData.data
                }
            });

            await this.extendObjectAsync(`${groupUuid}.${sceneData.id}`, {
                type: 'state',
                common: {
                    name: sceneData.metadata.name,
                    type: 'boolean',
                    role: 'switch',
                    write: true,
                    read: true
                },
                native: {
                    data: sceneData
                }
            });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param callback
     */
    async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.pollingInterval) {
                clearTimeout(this.pollingInterval);
                this.pollingInterval = undefined;
            }

            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = undefined;
            }

            this.pushClient.close();

            await this.setStateAsync('info.connection', false, true);

            this.log.info('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Handle messages from frontend
     *
     * @param obj the received message
     */
    async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj) {
            switch (obj.command) {
                case 'browse': {
                    const timeout = obj.message.timeout;
                    const res = await this.browse(timeout);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, res, obj.callback);
                    }
                    break;
                }
                case 'createUser': {
                    const res = await this.createUser(obj.message.ip as string, obj.message.port);
                    if (obj.callback) {
                        if (res.error === 0) {
                            this.sendTo(obj.from, obj.command, { user: res.message }, obj.callback);
                        } else if (res.error === 403) {
                            this.sendTo(obj.from, obj.command, { error: 'Not open' }, obj.callback);
                        } else {
                            this.sendTo(obj.from, obj.command, { error: 'Unknown error' }, obj.callback);
                        }
                    }
                    break;
                }
                default:
                    this.log.warn(`Unknown command: ${obj.command}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, obj.message, obj.callback);
                    }
                    break;
            }
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param id
     * @param state
     */
    async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!id || !state || state.ack) {
            return;
        }

        this.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
        const tmp = id.split('.');
        let dp = tmp.pop()!;

        let stateObj: ioBroker.Object | null | undefined;
        try {
            stateObj = await this.getForeignObjectAsync(id);
        } catch (e: any) {
            this.log.error(`Could not get object "${id}" on stateChange: ${e.message}`);
            return;
        }

        if (stateObj?.native?.data?.type === 'smart_scene') {
            try {
                const uuid = stateObj.native.data.id;

                if (state.val) {
                    this.log.info(`Start smart scene "${stateObj.common.name}"`);
                    await this.clientV2.startSmartScene(uuid);
                } else {
                    this.log.info(`Stop smart scene "${stateObj.common.name}"`);
                    await this.clientV2.stopSmartScene(uuid);
                }
            } catch (e: any) {
                this.log.error(`Could not start smart scene "${stateObj.common.name}": ${e.message}`);
            }

            return;
        }

        if (dp.startsWith('scene_')) {
            try {
                // it's a scene -> get a scene id to start it
                const groupState = new v3.lightStates.GroupLightState();

                if (!stateObj) {
                    throw new Error(`Object "${id}" is not existing`);
                }

                groupState.scene(stateObj.native.id);

                await this.api.groups.setGroupState(0, groupState);

                this.log.info(`Started scene: ${stateObj.common.name}`);
            } catch (e: any) {
                this.log.error(`Could not start scene: ${e.message || e}`);
            }
            return;
        }

        // check if it is a sensor
        const channelId = id.substring(0, id.lastIndexOf('.'));

        let channelObj;
        try {
            channelObj = await this.getForeignObjectAsync(channelId);
        } catch (e: any) {
            this.log.error(`Cannot get channelObj on stateChange for id "${id}" (${channelId}): ${e.message}`);
            return;
        }

        if (channelObj?.common?.role && SUPPORTED_SENSORS.includes(channelObj.common.role)) {
            // it's a sensor - we support turning it on and off
            try {
                if (dp === 'on') {
                    const sensor = await this.api.sensors.get(channelObj.native.id);
                    // @ts-expect-error is there are more official way?
                    sensor._data.config = { on: state.val };
                    await this.api.sensors.updateSensorConfig(sensor);
                    this.log.debug(`Changed ${dp} of sensor ${channelObj.native.id} to ${state.val}`);
                } else if (dp === 'status') {
                    const sensor = await this.api.sensors.get(channelObj.native.id);
                    // @ts-expect-error types are suboptimal
                    sensor.status = parseInt(state.val);
                    // @ts-expect-error types are suboptimal
                    await this.api.sensors.updateSensorState(sensor);
                    this.log.debug(`Changed ${dp} of sensor ${channelObj.native.id} to ${state.val}`);
                } else if (dp === 'flag') {
                    const sensor = await this.api.sensors.get(channelObj.native.id);
                    // @ts-expect-error types are suboptimal
                    sensor.flag = state.val;
                    // @ts-expect-error types are suboptimal
                    await this.api.sensors.updateSensorState(sensor);
                    this.log.debug(`Changed ${dp} of sensor ${channelObj.native.id} to ${state.val}`);
                } else {
                    this.log.warn(
                        `Changed ${dp} of sensor ${channelObj.native.id} to ${state.val} - currently not supported`
                    );
                }
            } catch (e: any) {
                this.log.error(`Cannot update sensor ${channelObj.native.id}: ${e.message}`);
            }
            return;
        }

        id = tmp.slice(2).join('.');

        // Enable/Disable streaming of Entertainment
        if (dp === 'activeStream') {
            if (state.val) {
                // turn streaming on
                this.log.debug(`Enable streaming of ${id} (${groupIds[id]})`);
                await this.api.groups.enableStreaming(groupIds[id]);
            } else {
                //turn streaming off
                this.log.debug(`Disable streaming of ${id} (${groupIds[id]})`);
                await this.api.groups.disableStreaming(groupIds[id]);
            }
            return;
        }

        // anyOn and allOn will just act like on dp
        if (dp === 'anyOn' || dp === 'allOn') {
            dp = 'on';
        }

        const fullIdBase = `${tmp.join('.')}.`;

        // if .on changed instead change .bri to 254 or 0, except it is a switch that has no brightness
        let bri = 0;
        if (
            dp === 'on' &&
            !this.config.nativeTurnOffBehaviour &&
            !(channelObj && channelObj.common && channelObj.common.role === 'switch')
        ) {
            bri = state.val ? 254 : 0;
            await this.setStateAsync([id, 'bri'].join('.'), { val: bri, ack: false });
            return;
        }
        // if .level changed instead change .bri to level.val*254
        if (dp === 'level' && typeof state.val === 'number') {
            bri = hueHelper.levelToBrightness(state.val);
            await this.setStateAsync([id, 'bri'].join('.'), { val: bri, ack: false });
            return;
        }
        // get lamp states
        let idStates: Record<string, ioBroker.State & { handled?: boolean }>;
        try {
            idStates = await this.getStatesAsync(`${id}.*`);
        } catch (e: any) {
            this.log.error(e);
            return;
        }

        // gather states that need to be changed
        const ls: Record<string, any> = {};
        const alls: Record<string, any> = {};
        let finalLS: Record<string, any> = {};
        let lampOn = false;
        let commandSupported = false;

        /**
         * Sets the light states and all light states according to the current state values
         * @param idState - state id
         * @param prefill - prefill requires ack of state to be true else it returns immediately
         */
        const handleParam: (idState: string, prefill: boolean) => void = (idState: string, prefill: boolean) => {
            if (!idStates[idState]) {
                return;
            }
            if (prefill && !idStates[idState].ack) {
                return;
            }

            const idtmp = idState.split('.');
            const iddp = idtmp.pop();
            switch (iddp) {
                case 'on':
                    alls.bri = idStates[idState].val ? 254 : 0;
                    ls.bri = idStates[idState].val ? 254 : 0;
                    if (idStates[idState].ack && ls.bri > 0) {
                        lampOn = true;
                    }
                    break;
                case 'bri':
                    alls.bri = idStates[idState].val;
                    ls.bri = idStates[idState].val;
                    // @ts-expect-error check it
                    if (idStates[idState].ack && idStates[idState].val > 0) {
                        lampOn = true;
                    }
                    break;
                case 'alert':
                    alls.alert = idStates[idState].val;
                    if (dp === 'alert') {
                        ls.alert = idStates[idState].val;
                    }
                    break;
                case 'effect':
                    alls[iddp] = idStates[idState].val;
                    if (dp === 'effect') {
                        ls[iddp] = idStates[idState].val;
                    }
                    break;
                case 'r':
                case 'g':
                case 'b':
                    alls[iddp] = idStates[idState].val;
                    if (dp === 'r' || dp === 'g' || dp === 'b') {
                        ls[iddp] = idStates[idState].val;
                    }
                    break;
                case 'ct':
                    alls[iddp] = idStates[idState].val;
                    if (dp === 'ct') {
                        ls[iddp] = idStates[idState].val;
                    }
                    break;
                case 'hue':
                case 'sat':
                    alls[iddp] = idStates[idState].val;
                    if (dp === 'hue' || dp === 'sat') {
                        ls[iddp] = idStates[idState].val;
                    }
                    break;
                case 'xy':
                    alls[iddp] = idStates[idState].val;
                    if (dp === 'xy') {
                        ls[iddp] = idStates[idState].val;
                    }
                    break;
                case 'command':
                    commandSupported = true;
                    alls[iddp] = idStates[idState].val;
                    break;
                default:
                    alls[iddp as string] = idStates[idState].val;
                    break;
            }
            idStates[idState].handled = true;
        };

        // work through the relevant states in the correct order for the logic to work
        // but only if ack=true - so real values from device
        handleParam(`${fullIdBase}on`, true);
        handleParam(`${fullIdBase}bri`, true);
        handleParam(`${fullIdBase}ct`, true);
        handleParam(`${fullIdBase}alert`, true);
        handleParam(`${fullIdBase}effect`, true);
        handleParam(`${fullIdBase}colormode`, true);
        handleParam(`${fullIdBase}r`, true);
        handleParam(`${fullIdBase}g`, true);
        handleParam(`${fullIdBase}b`, true);
        handleParam(`${fullIdBase}hue`, true);
        handleParam(`${fullIdBase}sat`, true);
        handleParam(`${fullIdBase}xy`, true);
        handleParam(`${fullIdBase}command`, true);
        handleParam(`${fullIdBase}level`, true);

        // Walk through the rest or ack=false (=to be changed) values
        for (const idState in idStates) {
            if (!idStates[idState] || idStates[idState].val === null || idStates[idState].handled) {
                continue;
            }
            handleParam(idState, false);
        }

        let sceneId;
        // Handle commands at the end because they overwrite also anything
        if (commandSupported && dp === 'command') {
            try {
                const commands = JSON.parse(state.val as string);

                if (typeof commands.scene === 'string') {
                    // we need to get the id of the scene - try the object scene-tree first
                    let sceneObj = await this.getObjectAsync(`${channelId}.scene_${commands.scene.toLowerCase()}`);
                    // if no id could be obtained, try the global scene-tree
                    if (sceneObj === null) {
                        sceneObj = await this.getObjectAsync(
                            `${this.namespace}.lightScenes.scene_${commands.scene.toLowerCase()}`
                        );
                    }

                    if (sceneObj?.native) {
                        sceneId = sceneObj.native.id;
                    }
                }

                for (const command of Object.keys(commands)) {
                    if (command === 'on') {
                        // if on is the only command and nativeTurnOn is activated
                        if (Object.keys(commands).length === 1 && this.config.nativeTurnOffBehaviour) {
                            finalLS.on = !!commands[command]; // we can set finalLs directly
                        } else {
                            // convert on to bri
                            if (commands[command] && !Object.prototype.hasOwnProperty.call(commands, 'bri')) {
                                ls.bri = 254;
                            } else {
                                ls.bri = 0;
                            }
                        }
                    } else if (command === 'level') {
                        //convert level to bri
                        if (!Object.prototype.hasOwnProperty.call(commands, 'bri')) {
                            ls.bri = hueHelper.levelToBrightness(parseInt(commands[command]));
                        } else {
                            ls.bri = 254;
                        }
                    } else {
                        ls[command] = commands[command];
                    }
                }
            } catch (e: any) {
                this.log.error(e.message);
                return;
            }
        }

        // maybe someone emitted a state change for a non-existing device via script
        if (!channelObj?.common?.role) {
            this.log.error(`Object "${id}" on stateChange is null, undefined or corrupted`);
            return;
        }

        // apply rgb to xy with modelId
        if ('r' in ls || 'g' in ls || 'b' in ls) {
            if (!('r' in ls) || ls.r > 255 || ls.r < 0 || typeof ls.r !== 'number') {
                ls.r = 0;
            }
            if (!('g' in ls) || ls.g > 255 || ls.g < 0 || typeof ls.g !== 'number') {
                ls.g = 0;
            }
            if (!('b' in ls) || ls.b > 255 || ls.b < 0 || typeof ls.b !== 'number') {
                ls.b = 0;
            }
            const xyb = hueHelper.RgbToXYB(
                ls.r / 255,
                ls.g / 255,
                ls.b / 255,
                Object.prototype.hasOwnProperty.call(channelObj.native, 'modelid')
                    ? channelObj.native.modelid.trim()
                    : 'default'
            );
            ls.bri = xyb.b;
            ls.xy = `${xyb.x},${xyb.y}`;
        }

        // create lightState from ls and check values
        let lightState = /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(channelObj.common.role)
            ? new v3.lightStates.GroupLightState()
            : new v3.lightStates.LightState();

        if (parseInt(ls.bri) > 0) {
            const bri = Math.min(254, ls.bri);
            if (isNaN(bri)) {
                throw new Error(`Error on converting value for bri: ${bri} - ${ls.bri} (${typeof ls.bri})`);
            }
            lightState = lightState.bri(bri);
            finalLS.bri = bri;
            // if nativeTurnOnOffBehaviour -> only turn a group on if no lamp is on yet on brightness change
            if (!this.config.nativeTurnOffBehaviour || !alls['anyOn']) {
                finalLS.on = true;
                lightState = lightState.on(true);
            }
        } else {
            lightState = lightState.off();
            finalLS.bri = 0;
            finalLS.on = false;
        }
        if ('xy' in ls) {
            if (typeof ls.xy !== 'string') {
                if (ls.xy) {
                    ls.xy = ls.xy.toString();
                } else {
                    this.log.warn(`Invalid xy value: "${ls.xy}"`);
                    ls.xy = '0,0';
                }
            }

            let xy = ls.xy.toString().split(',');
            xy = { x: xy[0], y: xy[1] };
            xy = hueHelper.GamutXYforModel(
                xy.x,
                xy.y,
                Object.prototype.hasOwnProperty.call(channelObj.native, 'modelid')
                    ? channelObj.native.modelid.trim()
                    : 'default'
            );
            if (!xy) {
                this.log.error(`Invalid "xy" value "${state.val}" for id "${id}"`);
                return;
            }

            finalLS.xy = `${xy.x},${xy.y}`;

            lightState = lightState.xy(parseFloat(xy.x), parseFloat(xy.y));

            if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
            const rgb = hueHelper.XYBtoRGB(xy.x, xy.y, finalLS.bri / 254);
            finalLS.r = Math.round(rgb.Red * 254);
            finalLS.g = Math.round(rgb.Green * 254);
            finalLS.b = Math.round(rgb.Blue * 254);
        }
        if ('ct' in ls) {
            if (typeof ls.ct !== 'number') {
                this.log.error(`Invalid "ct" value "${state.val}" (type: ${typeof ls.ct}) for id "${id}"`);
                return;
            }

            finalLS.ct = Math.max(MIN_CT, Math.min(MAX_CT, ls.ct));
            finalLS.ct = hueHelper.miredToKelvin(finalLS.ct);

            lightState = lightState.ct(finalLS.ct);
            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
        }
        if ('hue' in ls) {
            if (typeof ls.hue !== 'number') {
                this.log.error(`Invalid "hue" value "${state.val}" (type: ${typeof ls.hue}) for id "${id}"`);
                return;
            }

            finalLS.hue = Math.min(ls.hue, 360);
            if (finalLS.hue < 0) {
                finalLS.hue = 360;
            }
            // Convert 360° into 0-65535 value
            finalLS.hue = Math.round((finalLS.hue / 360) * 65535);

            if (finalLS.hue > 65535) {
                // may be round error
                finalLS.hue = 65535;
            }

            lightState = lightState.hue(finalLS.hue);
            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
        }
        if ('sat' in ls) {
            finalLS.sat = Math.max(0, Math.min(254, ls.sat)) || 0;
            lightState = lightState.sat(finalLS.sat);
            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
        }
        if ('alert' in ls) {
            if (['select', 'lselect'].indexOf(ls.alert) === -1) {
                finalLS.alert = 'none';
            } else {
                finalLS.alert = ls.alert;
            }
            lightState = lightState.alert(finalLS.alert);
        }
        if ('effect' in ls) {
            finalLS.effect = ls.effect ? 'colorloop' : 'none';

            lightState = lightState.effect(finalLS.effect);
            if (
                !lampOn &&
                ((finalLS.effect !== 'none' && !('bri' in ls)) || ls.bri === 0) &&
                this.config.turnOnWithOthers
            ) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
        }

        // only available in command state
        if ('transitiontime' in ls) {
            const transitiontime = Math.max(0, Math.min(65535, parseInt(ls.transitiontime)));
            if (!isNaN(transitiontime)) {
                finalLS.transitiontime = transitiontime;
                lightState = lightState.transitiontime(transitiontime);
            }
        }
        if ('sat_inc' in ls && !('sat' in finalLS) && 'sat' in alls) {
            finalLS.sat = (((ls.sat_inc + alls.sat) % 255) + 255) % 255;
            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
            lightState = lightState.sat(finalLS.sat);
        }
        if ('hue_inc' in ls && !('hue' in finalLS) && 'hue' in alls) {
            alls.hue = alls.hue % 360;
            if (alls.hue < 0) {
                alls.hue += 360;
            }
            // Convert 360° into 0-65535 value
            alls.hue = (alls.hue / 360) * 65535;

            if (alls.hue > 65535) {
                // may be round error
                alls.hue = 65535;
            }

            finalLS.hue = (((ls.hue_inc + alls.hue) % 65536) + 65536) % 65536;

            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
            lightState = lightState.hue(finalLS.hue);
        }
        if ('ct_inc' in ls && !('ct' in finalLS) && 'ct' in alls) {
            alls.ct = 500 - 153 - ((alls.ct - MIN_CT) / (MAX_CT - MIN_CT)) * (500 - 153) + 153;

            finalLS.ct = ((((alls.ct - 153 + ls.ct_inc) % 348) + 348) % 348) + 153;
            if (!lampOn && (!('bri' in ls) || ls.bri === 0) && this.config.turnOnWithOthers) {
                lightState = lightState.on(true);
                lightState = lightState.bri(254);
                finalLS.bri = 254;
                finalLS.on = true;
            }
            lightState = lightState.ct(finalLS.ct);
        }
        if ('bri_inc' in ls) {
            finalLS.bri = (((parseInt(alls.bri, 10) + parseInt(ls.bri_inc, 10)) % 255) + 255) % 255;
            if (finalLS.bri === 0) {
                if (lampOn) {
                    lightState = lightState.on(false);
                    finalLS.on = false;
                } else {
                    this.setState([id, 'bri'].join('.'), { val: 0, ack: false });
                    return;
                }
            } else {
                finalLS.on = true;
                lightState = lightState.on(true);
            }
            lightState = lightState.bri(finalLS.bri);
        }

        // change colormode
        if ('xy' in finalLS) {
            finalLS.colormode = 'xy';
        } else if ('ct' in finalLS) {
            finalLS.colormode = 'ct';
        } else if ('hue' in finalLS || 'sat' in finalLS) {
            finalLS.colormode = 'hs';
        }

        // set level to final bri / 2.54
        if ('bri' in finalLS) {
            finalLS.level = Math.max(Math.min(Math.round(finalLS.bri / 2.54), 100), 0);
        }

        // if dp is on, and we use native turn-off behaviour only set the lightState
        if (dp === 'on' && this.config.nativeTurnOffBehaviour) {
            // todo: this is somehow dirty but the code above is messy -> integrate above in a more clever way later
            lightState = /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(channelObj.common.role)
                ? new v3.lightStates.GroupLightState()
                : new v3.lightStates.LightState();
            if (state.val) {
                lightState.on(true);
            } else {
                lightState.off();
            }
        }

        // this can only happen for cmd - groups
        if (sceneId !== undefined && lightState instanceof GroupState) {
            lightState.scene(sceneId);
        }

        blockedIds[id] = true;

        if (!this.config.ignoreGroups && /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(channelObj.common.role)) {
            // log final changes / states
            this.log.debug(`final lightState for ${channelObj.common.name}:${JSON.stringify(finalLS)}`);
            try {
                await this.api.groups.setGroupState(groupIds[id], lightState);
                await this.delay(this.GROUP_UPDATE_DELAY_MS);
                await this.updateGroupState({
                    id: groupIds[id],
                    name: channelObj._id.substring(this.namespace.length + 1)
                });
                this.log.debug(`updated group state (${groupIds[id]}) after change`);
            } catch (e: any) {
                this.log.error(`Could not set GroupState of ${channelObj.common.name}: ${e.message}`);
            }
        } else if (channelObj.common.role === 'switch') {
            if (Object.prototype.hasOwnProperty.call(finalLS, 'on')) {
                finalLS = { on: finalLS.on };
                // log final changes / states
                this.log.debug(`final lightState for ${channelObj.common.name}:${JSON.stringify(finalLS)}`);

                lightState = new v3.lightStates.LightState();
                lightState.on(finalLS.on);
                try {
                    await this.api.lights.setLightState(channelIds[id], lightState);
                    await this.updateLightState({
                        id: channelIds[id],
                        name: channelObj._id.substring(this.namespace.length + 1)
                    });
                    this.log.debug(`updated LightState (${channelIds[id]}) after change`);
                } catch (e: any) {
                    this.log.error(`Could not set LightState of ${channelObj.common.name}: ${e.message}`);
                }
            } else {
                this.log.warn('invalid switch operation');
            }
        } else {
            // log final changes / states
            this.log.debug(`final lightState for ${channelObj.common.name}:${JSON.stringify(finalLS)}`);

            try {
                await this.api.lights.setLightState(channelIds[id], lightState);
                await this.updateLightState({
                    id: channelIds[id],
                    name: channelObj._id.substring(this.namespace.length + 1)
                });
                this.log.debug(`updated LightState (${channelIds[id]}) after change`);
            } catch (e: any) {
                this.log.error(`Could not set LightState of ${channelObj.common.name}: ${e.message}`);
            }
        }
    }

    /**
     * Search for bridges via upnp and nupnp
     *
     * @param timeout - timeout to abort the search
     */
    async browse(timeout: number): Promise<Record<string, any>[]> {
        if (isNaN(timeout)) {
            timeout = 5_000;
        }

        let res1 = [];
        let res2 = [];
        // methods can throw timeout error
        try {
            res1 = await v3.discovery.upnpSearch(timeout);
        } catch (e: any) {
            this.log.error(`Error on browsing via UPNP: ${e.message}`);
        }

        try {
            res2 = await v3.discovery.nupnpSearch();
        } catch (e: any) {
            this.log.error(`Error on browsing via NUPNP: ${e.message}`);
        }
        const bridges = res1.concat(res2);

        const ips: string[] = [];

        // rm duplicates - reverse because splicing
        for (let i = bridges.length - 1; i >= 0; i--) {
            if (ips.includes(bridges[i].ipaddress)) {
                bridges.splice(i, 1);
            } else {
                ips.push(bridges[i].ipaddress);
            }
        }

        const ipsWithLabels = ips.map(ip => ({
            value: ip,
            label: ip
        }));

        return ipsWithLabels;
    }

    /**
     * Create user on the bridge by given Ip
     *
     * @param ip - ip address of the bridge
     * @param port - port of the bridge
     */
    async createUser(ip: string, port: number): Promise<Record<string, any>> {
        const deviceName = 'ioBroker.hue';
        try {
            const api = this.config.ssl
                ? await v3.api.createLocal(ip, port).connect()
                : // @ts-expect-error third party types are incorrect
                  await v3.api.createInsecureLocal(ip, port).connect();

            const newUser = await api.users.createUser(ip, deviceName);
            this.log.info(`created new User: ${newUser.username}`);
            return { error: 0, message: newUser.username };
        } catch (e: any) {
            // 101 is bridge button not pressed
            if (!e.getHueErrorType || e.getHueErrorType() !== 101) {
                this.log.error(e.message);
            }
            // we see error as an error code only to detect 101, we do not use whole e here,
            // because it seems to be a circular structure sometimes
            return {
                error: e.getHueErrorType ? e.getHueErrorType() : -1,
                message: e.getHueErrorMessage ? e.getHueErrorMessage() : e.message
            };
        }
    }

    /**
     * polls the given group and sets states accordingly
     *
     * @param group group object containing id and name of the group
     */
    async updateGroupState(group: Record<string, any>): Promise<void> {
        this.log.debug(`polling group ${group.name} (${group.id})`);
        const values: { id: string; val: any }[] = [];

        try {
            let result: Record<string, any> = await this.api.groups.getGroup(group.id);
            const states: Record<string, any> = {};

            result = result['_data'];

            for (const stateA of Object.keys(result.action)) {
                states[stateA] = result.action[stateA];
            }

            // add the anyOn State
            states.anyOn = result.state['any_on'];
            states.allOn = result.state['all_on'];

            if (states.reachable === false && states.bri !== undefined) {
                states.bri = 0;
                states.on = false;
            }
            if (states.on === false && states.bri !== undefined) {
                states.bri = 0;
            }
            if (states.xy !== undefined) {
                const xy = states.xy.toString().split(',');
                states.xy = states.xy.toString();
                const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], states.bri / 254);
                states.r = Math.round(rgb.Red * 254);
                states.g = Math.round(rgb.Green * 254);
                states.b = Math.round(rgb.Blue * 254);
            }
            if (states.bri !== undefined) {
                states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
            }

            if (states.hue !== undefined) {
                states.hue = Math.round((states.hue / 65_535) * 360);
            }
            if (states.ct !== undefined) {
                // convert color temperature from mired to kelvin
                states.ct = hueHelper.miredToKelvin(states.ct);
                if (!isFinite(states.ct)) {
                    // issue #234
                    // invalid value we cannot determine the meant value, fallback to max
                    states.ct = 6536; // 153
                }
            }

            // Next two are entertainment states
            if (result.class) {
                states.class = result.class;
            }

            if (result.stream && result.stream.active !== undefined) {
                states.activeStream = result.stream.active;
            }

            for (const stateB of Object.keys(states)) {
                values.push({ id: `${this.namespace}.${group.name}.${stateB}`, val: states[stateB] });
            }
        } catch (e: any) {
            this.log.error(`Cannot update group state of ${group.name} (${group.id}): ${e.message || e}`);
        }

        // poll guard to prevent too fast polling of recently changed id
        const blockableId = group.name.replace(/[\s.]/g, '_');
        if (blockedIds[blockableId] === true) {
            this.log.debug(`Unblock ${blockableId}`);
            blockedIds[blockableId] = false;
        }

        await this.syncStates(values);
    }

    /**
     * poll the given light and sets states accordingly
     *
     * @param light object containing the light id and the name
     */
    async updateLightState(light: Record<string, any>): Promise<void> {
        this.log.debug(`polling light ${light.name} (${light.id})`);
        const values: { id: string; val: any }[] = [];

        try {
            let result = await this.api.lights.getLight(parseInt(light.id));
            const states: Record<string, any> = {};

            result = result['_data'];

            if (result.swupdate && result.swupdate.state) {
                values.push({ id: `${this.namespace}.${light.name}.updateable`, val: result.swupdate.state });
            }

            for (const stateA of Object.keys(result.state)) {
                states[stateA] = result.state[stateA];
            }

            if (!this.config.ignoreOsram) {
                if (states.reachable === false && states.bri !== undefined) {
                    states.bri = 0;
                    states.on = false;
                }
            }

            if (states.on === false && states.bri !== undefined) {
                states.bri = 0;
            }
            if (states.xy !== undefined) {
                const xy = states.xy.toString().split(',');
                states.xy = states.xy.toString();
                const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], states.bri / 254);
                states.r = Math.round(rgb.Red * 254);
                states.g = Math.round(rgb.Green * 254);
                states.b = Math.round(rgb.Blue * 254);
            }
            if (states.bri !== undefined) {
                states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
            }

            if (states.hue !== undefined) {
                states.hue = Math.round((states.hue / 65535) * 360);
            }
            if (states.ct !== undefined) {
                states.ct = hueHelper.miredToKelvin(states.ct);
            }
            for (const stateB of Object.keys(states)) {
                values.push({ id: `${this.namespace}.${light.name}.${stateB}`, val: states[stateB] });
            }
        } catch (e: any) {
            this.log.error(`Cannot update light state ${light.name} (${light.id}): ${e.message}`);
        }

        // poll guard to prevent too fast polling of recently changed id
        const blockableId = light.name.replace(/[\s.]/g, '_');
        if (blockedIds[blockableId] === true) {
            this.log.debug(`Unblock ${blockableId}`);
            blockedIds[blockableId] = false;
        }

        await this.syncStates(values);
    }

    /**
     * Create a push connection to the Hue bridge, to listen to updates in near real-time
     */
    createPushConnection(): void {
        // @ts-expect-error lib export is wrong
        this.pushClient = new HuePushClient({ ip: this.config.bridge, user: this.config.user });

        this.pushClient.addEventListener('open', async () => {
            this.log.info('Push connection established');
            try {
                this.UUIDs = await this.pushClient.uuids();
            } catch (e: any) {
                this.log.error(`Could not get UUIDs: ${e.message}`);
            }
        });

        this.pushClient.addEventListener('close', () => {
            this.log.info('Push connection closed');
        });

        this.pushClient.addEventListener('error', (e: any) => {
            this.log.info(`Push connection error: ${e.message}`);
        });

        this.pushClient.addEventListener('message', (message: any) => {
            if (!message.data) {
                return;
            }

            try {
                const data = JSON.parse(message.data);
                this.log.debug(`Received on push connection: ${JSON.stringify(data)}`);

                for (const timestepData of data) {
                    for (const entry of timestepData.data) {
                        this.handleUpdate(entry);
                    }
                }
            } catch (e: any) {
                this.log.error(`Could not parse data from push connection: ${e.message}`);
            }
        });
    }

    /**
     * Handle update received by bridge
     *
     * @param update update received by bridge
     */
    async handleUpdate(update: BridgeUpdate): Promise<void> {
        this.log.debug(`New push connection update: ${JSON.stringify(update)}`);

        if (update.type === 'contact') {
            await this.handleContactSensorUpdate(update);
            return;
        }

        if (update.type === 'tamper') {
            await this.handleTamperUpdate(update);
            return;
        }

        if (update.type === 'device_power') {
            await this.handleDevicePowerUpdate(update);
            return;
        }

        if (!update.id_v1) {
            this.log.debug('Ignore push connection update, because property "id_v1" is missing');
            return;
        }

        const id = parseInt(update.id_v1.split('/')[2]);

        if (update.type === 'light') {
            await this.handleLightUpdate(id, update);
            return;
        }

        if (update.type === 'grouped_light' || update.type === 'entertainment_configuration') {
            await this.handleGroupUpdate(id, update);
            return;
        }

        if (
            ['motion', 'temperature', 'light_level', 'device_power', 'button', 'relative_rotary'].includes(update.type)
        ) {
            await this.handleSensorUpdate(id, update);
            return;
        }

        if (update.type === 'zigbee_connectivity') {
            // ignore for now
            return;
        }

        if (update.type === 'scene') {
            // ignore for now
            return;
        }

        this.log.warn(`Unknown update for type "${update.type}": ${JSON.stringify(update)}`);
    }

    /**
     * Handle sensor specific update
     *
     * @param id id of the sensor
     * @param update the update sent by bridge
     */
    async handleSensorUpdate(id: number, update: BridgeUpdate): Promise<void> {
        const channelName = this.getSensorChannelById(id);

        if (update.temperature?.temperature_valid) {
            await this.setStateAsync(`${channelName}.temperature`, update.temperature.temperature, true);
        }

        if (update.motion?.motion_valid) {
            await this.setStateAsync(`${channelName}.presence`, update.motion.motion, true);
        }

        if (update.light?.light_level_valid) {
            await this.setStateAsync(`${channelName}.lightlevel`, update.light.light_level, true);
        }

        if (update.power_state) {
            await this.setStateAsync(`${channelName}.battery`, update.power_state.battery_level, true);
        }

        if (update.button?.button_report) {
            await this.setStateAsync(`${channelName}.lastupdated`, update.button.button_report.updated, true);
            await this.setStateAsync(
                `${channelName}.buttonevent`,
                this.transformButtonEvent({ event: update.button.button_report.event, id: update.id }),
                true
            );
        }

        if (update.relative_rotary?.rotary_report) {
            await this.setStateAsync(`${channelName}.lastupdated`, update.relative_rotary.rotary_report.updated, true);
            await this.setStateAsync(
                `${channelName}.rotaryevent`,
                update.relative_rotary.rotary_report.action === 'start' ? 1 : 2,
                true
            );
        }
    }

    /**
     * Transform button event from push api to poll api code
     *
     * @param options update related information like an event type and uuid
     */
    transformButtonEvent(options: { event: ButtonEventType; id: string }): number {
        const { event, id } = options;

        const eventType = event === 'repeat' ? 1 : event === 'short_release' ? 2 : event === 'long_release' ? 3 : 0;

        return (this.UUIDs[id]?.metadata?.control_id ?? 0) * 1_000 + eventType;
    }

    /**
     * Handle light specific update
     *
     * @param id id of the light
     * @param update the update sent by bridge
     */
    async handleLightUpdate(id: number, update: BridgeUpdate): Promise<void> {
        const channelName = this.getLightChannelById(id);

        if (update.on) {
            await this.setStateAsync(`${channelName}.on`, update.on.on, true);
        }

        if (update.dimming) {
            await this.setStateAsync(`${channelName}.level`, Math.round(update.dimming.brightness), true);
            await this.setStateAsync(
                `${channelName}.bri`,
                hueHelper.levelToBrightness(update.dimming.brightness),
                true
            );
        }

        if (update.color_temperature?.mirek_valid) {
            await this.setStateAsync(
                `${channelName}.ct`,
                hueHelper.miredToKelvin(update.color_temperature.mirek!),
                true
            );
        }

        if (update.color) {
            await this.setStateAsync(`${channelName}.xy`, `${update.color.xy.x},${update.color.xy.y}`, true);
            await this.updateColorStatesByXY(channelName, update.color.xy.x, update.color.xy.y);
        }
    }

    /**
     * Update the RGB, Hue and sat states of a channel by given x, y values
     *
     * @param channelName ioBroker channel name
     * @param x x-value
     * @param y y-value
     */
    async updateColorStatesByXY(channelName: string, x: number, y: number): Promise<void> {
        const state = await this.getStateAsync(`${channelName}.bri`);

        if (!state || typeof state.val !== 'number') {
            return;
        }

        const bri = state.val;

        const { Red, Green, Blue } = hueHelper.XYBtoRGB(x, y, bri / 254);

        await this.setStateAsync(`${channelName}.r`, Math.round(Red * 254), true);
        await this.setStateAsync(`${channelName}.g`, Math.round(Green * 254), true);
        await this.setStateAsync(`${channelName}.b`, Math.round(Blue * 254), true);

        /** TODO: this converts to wrong HS values
        const { Ang, Sat } = hueHelper.RgbToHsv(Red, Green, Blue);

        this.setState(`${channelName}.hue`, Math.round(Ang), true);
        this.setState(`${channelName}.sat`, Math.round(Sat * 254), true);
         */
    }

    /**
     * Handle update from contact sensor
     *
     * @param update the update sent by bridge
     */
    async handleContactSensorUpdate(update: BridgeUpdate): Promise<void> {
        if (!update.contact_report) {
            return;
        }

        const deviceId = update.owner.rid;

        await this.setStateAsync(`${deviceId}.${update.id}`, this.contactToStateVal(update.contact_report.state), true);
    }

    /**
     * Handle tamper update
     *
     * @param update the update sent by bridge
     */
    async handleTamperUpdate(update: BridgeUpdate): Promise<void> {
        if (!update.tamper_reports) {
            return;
        }

        const deviceId = update.owner.rid;
        const iobId = `${deviceId}.${update.id}`;
        const stateExists = await this.objectExists(iobId);

        if (stateExists) {
            await this.setStateAsync(iobId, this.tamperToStateVal(update.tamper_reports[0].state), true);
        }
    }

    /**
     * Handle update for device power
     *
     * @param update the update sent by bridge
     */
    async handleDevicePowerUpdate(update: BridgeUpdate): Promise<void> {
        if (!update.power_state) {
            return;
        }

        const deviceId = update.owner.rid;
        const iobId = `${deviceId}.${update.id}`;
        const stateExists = await this.objectExists(iobId);

        if (stateExists) {
            await this.setStateAsync(iobId, update.power_state.battery_level, true);
        }
    }

    /**
     * Handle group specific update
     *
     * @param id id of the group
     * @param update the update sent by bridge
     */
    async handleGroupUpdate(id: number, update: BridgeUpdate): Promise<void> {
        const channelName = this.getGroupChannelById(id);

        if (!channelName) {
            this.log.debug(`Could not handle update of group "${id}", because no matching channel found`);
            return;
        }

        if (update.dimming) {
            await this.setStateAsync(`${channelName}.level`, Math.round(update.dimming.brightness), true);
            await this.setStateAsync(
                `${channelName}.bri`,
                hueHelper.levelToBrightness(update.dimming.brightness),
                true
            );
        }

        if (update.on) {
            await this.setStateAsync(`${channelName}.on`, update.on.on, true);
        }

        if (update.active_streamer) {
            await this.setStateAsync(`${channelName}.activeStream`, update.status === 'active', true);
        }
    }

    /**
     * Get ioBroker channel name by sensor id
     *
     * @param id the sensor id
     */
    getSensorChannelById(id: number): string {
        const sensor = pollSensors.find(sensor => sensor.id === id.toString())!;

        return sensor.name;
    }

    /**
     * Get ioBroker channel name by light id
     *
     * @param id the light id
     */
    getLightChannelById(id: number): string {
        const idx = Object.values(channelIds).indexOf(id.toString());

        return Object.keys(channelIds)[idx];
    }

    /**
     * Get ioBroker channel name by group id
     *
     * @param id the group id
     */
    getGroupChannelById(id: number): string | undefined {
        const idx = Object.values(groupIds).indexOf(id.toString());

        return Object.keys(groupIds)[idx];
    }

    /**
     * Connects to the bridge and creates the initial objects
     */
    async connect(): Promise<void> {
        let config;
        try {
            if (this.config.ssl) {
                this.log.debug(`Using https to connect to ${this.config.bridge}:${this.config.port}`);
                this.api = await v3.api.createLocal(this.config.bridge, this.config.port).connect(this.config.user);
                this.createPushConnection();
            } else {
                this.log.debug(`Using insecure http to connect to ${this.config.bridge}:${this.config.port}`);
                this.api = await v3.api
                    .createInsecureLocal(this.config.bridge, this.config.port)
                    // @ts-expect-error should be correct -> third party types wrong
                    .connect(this.config.user);
            }

            config = await this.api.configuration.getAll();
        } catch (e: any) {
            this.log.error(e.message || e);
        }

        if (!config?.config) {
            this.log.warn(`Could not get configuration from HUE bridge (${this.config.bridge}:${this.config.port})`);
            this.reconnectTimeout = this.setTimeout(() => {
                this.reconnectTimeout = undefined;
                this.connect();
            }, 5_000);
            return;
        }

        // even if useLegacyStructure is false, we check if the structure exists to not create chaos
        if (!this.config.useLegacyStructure) {
            const legacyObj = await this.getObjectAsync(
                `${this.namespace}.${config.config.name.replace(/[\s.]/g, '_')}`
            );
            if (legacyObj) {
                this.config.useLegacyStructure = true;
                this.log.info('Use legacy structure, because existing');
            }
        }

        const channelNames = [];

        // Create/update lamps
        const lights = config.lights;
        const sensors = config.sensors;
        const sensorsArr = sensors ? Object.keys(sensors) : [];
        const lightsArr = lights ? Object.keys(lights) : [];
        const objs: (ioBroker.SettableStateObject | ioBroker.SettableChannelObject | ioBroker.SettableDeviceObject)[] =
            [];

        await this.setStateAsync('info.connection', true, true);

        noDevices = sensorsArr.length + lightsArr.length;

        for (const sid of sensorsArr) {
            const sensor = sensors[sid];

            if (SUPPORTED_SENSORS.includes(sensor.type)) {
                let channelName = this.config.useLegacyStructure
                    ? `${config.config.name.replace(/\./g, '_')}.${sensor.name.replace(this.FORBIDDEN_CHARS, '')}`
                    : sensor.name.replace(this.FORBIDDEN_CHARS, '');
                let existingChObj;
                try {
                    existingChObj = await this.getObjectAsync(channelName.replace(/\s/g, '_'));
                } catch (e: any) {
                    this.log.warn(`Could not check channel existence: ${e.message}`);
                }

                // if channel name already taken or channel object already exists with another role, we have to adjust name
                if (
                    channelNames.indexOf(channelName) !== -1 ||
                    (existingChObj && existingChObj.common && existingChObj.common.role !== sensor.type)
                ) {
                    const newChannelName = `${channelName} ${sensor.type}`;
                    if (channelNames.indexOf(newChannelName) !== -1) {
                        this.log.error(
                            `channel "${channelName.replace(
                                /\s/g,
                                '_'
                            )}" already exists, could not use "${newChannelName.replace(
                                /\s/g,
                                '_'
                            )}" as well, skipping sensor ${sid}`
                        );
                        continue;
                    } else {
                        this.log.warn(
                            `channel "${channelName.replace(
                                /\s/g,
                                '_'
                            )}" already exists, using "${newChannelName.replace(/\s/g, '_')}" for sensor ${sid}`
                        );
                        channelName = newChannelName;
                    }
                } else {
                    channelNames.push(channelName);
                }

                const sensorName = sensor.name.replace(/[\s.]/g, '');

                pollSensors.push({ id: sid, name: channelName.replace(/\s/g, '_'), sname: sensorName });

                const sensorCopy = { ...sensor.state, ...sensor.config };
                for (const state of Object.keys(sensorCopy)) {
                    const objId = `${channelName}.${state}`;

                    const lobj: ioBroker.SettableStateObject = {
                        _id: `${this.namespace}.${objId.replace(/\s/g, '_')}`,
                        type: 'state',
                        common: {
                            type: 'mixed',
                            name: objId,
                            read: true,
                            write: true,
                            role: 'state'
                        },
                        native: {
                            id: sid
                        }
                    };

                    let value = sensorCopy[state];

                    switch (state) {
                        case 'on':
                            lobj.common.type = 'boolean';
                            lobj.common.role = 'switch';
                            lobj.common.write = true;
                            break;
                        case 'reachable':
                            lobj.common.type = 'boolean';
                            lobj.common.write = false;
                            lobj.common.role = 'indicator.reachable';
                            break;
                        case 'buttonevent':
                            lobj.common.type = 'number';
                            lobj.common.role = 'state';
                            lobj.common.write = false;
                            break;
                        case 'lastupdated':
                            lobj.common.type = 'string';
                            lobj.common.role = 'date';
                            lobj.common.write = false;
                            break;
                        case 'battery':
                            lobj.common.type = 'number';
                            lobj.common.role = 'value.battery';
                            lobj.common.unit = '%';
                            lobj.common.write = false;
                            break;
                        case 'pending':
                            lobj.common.type = 'array';
                            lobj.common.role = 'config';
                            lobj.common.write = false;
                            break;
                        case 'daylight':
                            lobj.common.type = 'boolean';
                            lobj.common.role = 'switch';
                            break;
                        case 'dark':
                            lobj.common.type = 'boolean';
                            lobj.common.role = 'switch';
                            break;
                        case 'presence':
                            lobj.common.type = 'boolean';
                            lobj.common.role = 'switch';
                            break;
                        case 'lightlevel':
                            lobj.common.type = 'number';
                            lobj.common.role = 'lightlevel';
                            lobj.common.min = 0;
                            break;
                        case 'temperature':
                            lobj.common.type = 'number';
                            lobj.common.role = 'indicator.temperature';
                            lobj.common.write = false;
                            value = this.convertTemperature(value);
                            break;
                        case 'rotaryevent':
                            lobj.common.type = 'number';
                            lobj.common.role = 'state';
                            lobj.common.write = false;
                            break;
                        case 'expectedrotation':
                            lobj.common.type = 'number';
                            lobj.common.role = 'state';
                            lobj.common.write = false;
                            lobj.common.unit = '°';
                            break;
                        case 'expectedeventduration':
                            lobj.common.type = 'number';
                            lobj.common.role = 'state';
                            lobj.common.write = false;
                            lobj.common.unit = 'ms';
                            break;
                        default:
                            lobj.common.type = 'mixed';
                            this.log.info(`skip switch: ${objId}`);
                            break;
                    }

                    lobj.common.def = value && typeof value === 'object' ? JSON.stringify(value) : value;
                    objs.push(lobj);
                }

                objs.push({
                    _id: `${this.namespace}.${channelName.replace(/\s/g, '_')}`,
                    type: 'channel',
                    common: {
                        name: channelName,
                        role: sensor.type
                    },
                    native: {
                        id: sid,
                        type: sensor.type,
                        name: sensor.name,
                        modelid: sensor.modelid,
                        swversion: sensor.swversion
                    }
                });
            }
        }

        this.log.info(`created/updated ${pollSensors.length} sensor channels`);

        for (const lid of lightsArr) {
            const light = lights[lid];

            let channelName = this.config.useLegacyStructure
                ? `${config.config.name.replace(/\./g, '_')}.${light.name.replace(/\./g, '_')}`
                : light.name.replace(/\./g, '_');
            let existingChObj;
            try {
                existingChObj = await this.getObjectAsync(channelName.replace(/\s/g, '_'));
            } catch (e: any) {
                this.log.warn(`Could not check channel existence: ${e.message}`);
            }

            // if channel name already taken or channel object already exists with another role, we have to adjust name
            if (
                channelNames.indexOf(channelName) !== -1 ||
                (existingChObj &&
                    existingChObj.common &&
                    existingChObj.common.role &&
                    !existingChObj.common.role.startsWith('light') &&
                    existingChObj.common.role !== 'switch')
            ) {
                const newChannelName = `${channelName} ${light.type}`;
                if (channelNames.indexOf(newChannelName) !== -1) {
                    this.log.error(
                        `channel "${channelName.replace(
                            /\s/g,
                            '_'
                        )}" already exists, could not use "${newChannelName.replace(
                            /\s/g,
                            '_'
                        )}" as well, skipping light ${lid}`
                    );
                    continue;
                } else {
                    this.log.warn(
                        `channel "${channelName.replace(/\s/g, '_')}" already exists, using "${newChannelName.replace(
                            /\s/g,
                            '_'
                        )}" for light ${lid}`
                    );
                    channelName = newChannelName;
                }
            } else {
                channelNames.push(channelName);
            }
            channelIds[channelName.replace(/\s/g, '_')] = lid;
            pollLights.push({ id: lid, name: channelName.replace(/\s/g, '_') });

            if (light.type === 'Extended color light' || light.type === 'Color light') {
                light.state.r = 0;
                light.state.g = 0;
                light.state.b = 0;
            }

            if (!light.type.startsWith('On/Off')) {
                light.state.command = '{}';
                light.state.level = 0;
            }

            // Create swUpdate state for every light
            if (light.swupdate && light.swupdate.state) {
                const objId = `${channelName}.updateable`;

                const lobj: ioBroker.SettableStateObject = {
                    _id: `${this.namespace}.${objId.replace(/\s/g, '_')}`,
                    type: 'state',
                    common: {
                        name: objId,
                        read: true,
                        write: false,
                        type: 'string',
                        role: 'indicator.update',
                        def: light.swupdate.state
                    },
                    native: {
                        id: lid
                    }
                };
                objs.push(lobj);
            }

            for (const state of Object.keys(light.state)) {
                // ...existing code für die State-Objekte...
                // (unverändert, siehe oben)
                let value = light.state[state];
                const objId = `${channelName}.${state}`;
                const lobj: ioBroker.SettableStateObject = {
                    _id: `${this.namespace}.${objId.replace(/\s/g, '_')}`,
                    type: 'state',
                    common: {
                        type: 'mixed',
                        name: objId,
                        read: true,
                        write: true,
                        role: 'state'
                    },
                    native: {
                        id: lid
                    }
                };
                // ...switch/case wie gehabt...
                switch (state) {
                    case 'on':
                        lobj.common.type = 'boolean';
                        lobj.common.role = 'switch.light';
                        break;
                    case 'bri':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.dimmer';
                        lobj.common.min = 0;
                        lobj.common.max = 254;
                        break;
                    case 'level':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.dimmer';
                        lobj.common.min = 0;
                        lobj.common.max = 100;
                        break;
                    case 'hue':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.hue';
                        lobj.common.unit = '°';
                        lobj.common.min = 0;
                        lobj.common.max = 360;
                        value = Math.round((value / 65535) * 360);
                        break;
                    case 'sat':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.saturation';
                        lobj.common.min = 0;
                        lobj.common.max = 254;
                        break;
                    case 'xy':
                        lobj.common.type = 'string';
                        lobj.common.role = 'level.color.xy';
                        break;
                    case 'ct': {
                        let ctObj = { min: 153, max: 500 }; // fallback object
                        try {
                            const light = await this.api.lights.getLight(parseInt(lid));
                            ctObj = light._populationData.capabilities.control.ct || ctObj;
                            if (ctObj.min === 0) {
                                ctObj.min = 153;
                            }
                            if (ctObj.max === 65535 || ctObj.max === 0) {
                                ctObj.max = 500;
                            }
                        } catch {}
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.temperature';
                        lobj.common.unit = '°K';
                        lobj.common.min = hueHelper.miredToKelvin(ctObj.max);
                        lobj.common.max = hueHelper.miredToKelvin(ctObj.min);
                        value = hueHelper.miredToKelvin(value);
                        if (!isFinite(value)) {
                            value = lobj.common.max;
                        }
                        break;
                    }
                    case 'alert':
                        lobj.common.type = 'string';
                        lobj.common.role = 'text';
                        break;
                    case 'effect':
                        lobj.common.type = 'string';
                        lobj.common.role = 'text';
                        break;
                    case 'colormode':
                        lobj.common.type = 'string';
                        lobj.common.role = 'colormode';
                        lobj.common.write = false;
                        break;
                    case 'reachable':
                        lobj.common.type = 'boolean';
                        lobj.common.write = false;
                        lobj.common.role = 'indicator.reachable';
                        break;
                    case 'r':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.red';
                        lobj.common.min = 0;
                        lobj.common.max = 255;
                        break;
                    case 'g':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.green';
                        lobj.common.min = 0;
                        lobj.common.max = 255;
                        break;
                    case 'b':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.blue';
                        lobj.common.min = 0;
                        lobj.common.max = 255;
                        break;
                    case 'command':
                        lobj.common.type = 'string';
                        lobj.common.role = 'command';
                        break;
                    case 'pending':
                        lobj.common.type = 'array';
                        lobj.common.role = 'config';
                        break;
                    case 'mode':
                        lobj.common.type = 'string';
                        lobj.common.role = 'text';
                        break;
                    case 'transitiontime':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level';
                        lobj.common.min = 0;
                        lobj.common.max = 64000;
                        lobj.common.unit = 'ds';
                        break;
                    default:
                        this.log.info(`skip light: ${objId}`);
                        break;
                }
                lobj.common.def = value && typeof value === 'object' ? JSON.stringify(value) : value;
                objs.push(lobj);
            }

            let role = 'light.color';
            if (light.type === 'Dimmable light' || light.type === 'Dimmable plug-in unit') {
                role = 'light.dimmer';
            } else if (light.type.startsWith('On/Off')) {
                role = 'switch';
            }
            // Gamut-Information für das Channel-Objekt bestimmen
            let gamutType: string | undefined = undefined;
            if (light.capabilities && light.capabilities.control && light.capabilities.control.colorgamuttype) {
                gamutType = light.capabilities.control.colorgamuttype;
            } else {
                gamutType = hueHelper.getGamutTypeForModel(light.modelid ? light.modelid.trim() : 'default');
            }
            objs.push({
                _id: `${this.namespace}.${channelName.replace(/\s/g, '_')}`,
                type: 'channel',
                common: {
                    name: channelName,
                    role: role
                },
                native: {
                    id: lid,
                    type: light.type,
                    name: light.name,
                    modelid: light.modelid,
                    swversion: light.swversion,
                    pointsymbol: light.pointsymbol,
                    gamutType: gamutType // Gamut-Info im native-Block
                }
            });
        }

        this.log.info(`created/updated ${pollLights.length} light channels`);

        // Create/update groups
        if (!this.config.ignoreGroups) {
            if (!config.groups) {
                this.log.error(`Could not get groups from API: ${JSON.stringify(config)}`);
                this.restart();
                return;
            }

            const groups = config.groups;
            groups[0] = {
                name: 'All', // "Lightset 0"
                type: 'LightGroup',
                id: 0,
                action: {
                    alert: 'select',
                    bri: 0,
                    colormode: '',
                    ct: 454, // min value, else it gets inf
                    effect: 'none',
                    hue: 0,
                    on: false,
                    sat: 0,
                    xy: '0,0'
                }
            };

            const groupsArr = Object.keys(groups);
            noDevices += groupsArr.length;

            for (const gid of groupsArr) {
                const group = groups[gid];

                let groupName = this.config.useLegacyStructure
                    ? `${config.config.name.replace(/\./g, '_')}.${group.name.replace(/\./g, '_')}`
                    : group.name.replace(/\./g, '_');
                let existingChObj;
                try {
                    existingChObj = await this.getObjectAsync(groupName.replace(/\s/g, '_'));
                } catch (e: any) {
                    this.log.warn(`Could not check channel existence: ${e.message}`);
                }

                // if group name already taken or channel object already exists with another role, we have to adjust name
                if (
                    channelNames.indexOf(groupName) !== -1 ||
                    (existingChObj?.common?.role &&
                        !['Entertainment', 'LightGroup', 'Room', 'Zone'].includes(existingChObj.common.role))
                ) {
                    const newGroupName = `${groupName} ${group.type}`;
                    if (channelNames.indexOf(newGroupName) !== -1) {
                        this.log.error(
                            `channel "${groupName.replace(
                                /\s/g,
                                '_'
                            )}" already exists, could not use "${newGroupName.replace(
                                /\s/g,
                                '_'
                            )}" as well, skipping group ${gid}`
                        );
                        continue;
                    } else {
                        this.log.warn(
                            `channel "${groupName.replace(/\s/g, '_')}" already exists, using "${newGroupName.replace(
                                /\s/g,
                                '_'
                            )}" for group ${gid}`
                        );
                        groupName = newGroupName;
                    }
                } else {
                    channelNames.push(groupName);
                }
                groupIds[groupName.replace(/\s/g, '_')] = gid;
                pollGroups.push({ id: gid, name: groupName.replace(/\s/g, '_') });

                group.action.r = 0;
                group.action.g = 0;
                group.action.b = 0;
                group.action.command = '{}';
                group.action.level = 0;

                for (const action of Object.keys(group.action)) {
                    const gobjId = `${groupName}.${action}`;

                    const gobj: ioBroker.SettableStateObject = {
                        _id: `${this.namespace}.${gobjId.replace(/\s/g, '_')}`,
                        type: 'state',
                        common: {
                            type: 'mixed',
                            name: gobjId,
                            read: true,
                            write: true,
                            role: 'state'
                        },
                        native: {
                            id: gid
                        }
                    };
                    if (tools.isObject(group.action[action])) {
                        group.action[action] = group.action[action].toString();
                    }

                    switch (action) {
                        case 'on':
                            gobj.common.type = 'boolean';
                            gobj.common.role = 'switch';
                            break;
                        case 'bri':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.dimmer';
                            gobj.common.min = 0;
                            gobj.common.max = 254;
                            break;
                        case 'level':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.dimmer';
                            gobj.common.min = 0;
                            gobj.common.max = 100;
                            break;
                        case 'hue':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.hue';
                            gobj.common.unit = '°';
                            gobj.common.min = 0;
                            gobj.common.max = 360;
                            // rescale to max of 360 instead of max 65535
                            group.action[action] = Math.round((group.action[action] / 65535) * 360);
                            break;
                        case 'sat':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.saturation';
                            gobj.common.min = 0;
                            gobj.common.max = 254;
                            break;
                        case 'xy':
                            gobj.common.type = 'string';
                            gobj.common.role = 'level.color.xy';
                            break;
                        case 'ct':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.temperature';
                            gobj.common.unit = '°K';
                            gobj.common.min = 1802; // normally 500 (2000) but some groups have smaller values due to third pary lights and we cannot get min via api for groups
                            gobj.common.max = 6536; // 153
                            group.action[action] = hueHelper.miredToKelvin(group.action[action]);
                            if (!isFinite(group.action[action])) {
                                // issue #234
                                // invalid value we cannot determine the meant value, fallback to max
                                group.action[action] = gobj.common.max;
                            }
                            break;
                        case 'alert':
                            gobj.common.type = 'string';
                            gobj.common.role = 'switch';
                            break;
                        case 'effect':
                            gobj.common.type = 'string';
                            gobj.common.role = 'switch';
                            break;
                        case 'colormode':
                            gobj.common.type = 'string';
                            gobj.common.role = 'sensor.colormode';
                            gobj.common.write = false;
                            break;
                        case 'r':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.red';
                            gobj.common.min = 0;
                            gobj.common.max = 255;
                            break;
                        case 'g':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.green';
                            gobj.common.min = 0;
                            gobj.common.max = 255;
                            break;
                        case 'b':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.blue';
                            gobj.common.min = 0;
                            gobj.common.max = 255;
                            break;
                        case 'command':
                            gobj.common.type = 'string';
                            gobj.common.role = 'command';
                            break;
                        case 'status':
                            gobj.common.type = 'number';
                            gobj.common.role = 'indicator.status';
                            break;
                        case 'transitiontime':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level';
                            gobj.common.min = 0;
                            gobj.common.max = 64000;
                            gobj.common.unit = 'ds';
                            break;
                        default:
                            this.log.info(`skip group: ${gobjId}`);
                            continue;
                    }
                    gobj.common.def =
                        group.action[action] && typeof group.action[action] === 'object'
                            ? JSON.stringify(group.action[action])
                            : group.action[action];
                    objs.push(gobj);
                }

                // Create anyOn state
                objs.push({
                    _id: `${this.namespace}.${groupName.replace(/\s/g, '_')}.anyOn`,
                    type: 'state',
                    common: {
                        name: `${groupName}.anyOn`,
                        type: 'boolean',
                        role: 'indicator.switch',
                        read: true,
                        write: true,
                        def: gid !== '0' ? group.state['any_on'] : false
                    },
                    native: {}
                });

                // Create allOn state
                objs.push({
                    _id: `${this.namespace}.${groupName.replace(/\s/g, '_')}.allOn`,
                    type: 'state',
                    common: {
                        name: `${groupName}.allOn`,
                        type: 'boolean',
                        role: 'indicator.switch',
                        read: true,
                        write: true,
                        def: gid !== '0' ? group.state['all_on'] : false
                    },
                    native: {}
                });

                // Create entertainment states
                if (group.class) {
                    objs.push({
                        _id: `${this.namespace}.${groupName.replace(/\s/g, '_')}.class`,
                        type: 'state',
                        common: {
                            type: 'string',
                            name: `${groupName}.class`,
                            role: 'indicator',
                            read: true,
                            write: false,
                            def: group.class
                        },
                        native: {}
                    });
                }

                if (group.stream && group.stream.active !== undefined) {
                    objs.push({
                        _id: `${this.namespace}.${groupName.replace(/\s/g, '_')}.activeStream`,
                        type: 'state',
                        common: {
                            name: `${groupName}.activeStream`,
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: true,
                            def: group.stream.active
                        },
                        native: {}
                    });
                }

                objs.push({
                    _id: `${this.namespace}.${groupName.replace(/\s/g, '_')}`,
                    type: 'channel',
                    common: {
                        name: groupName,
                        role: group.type
                    },
                    native: {
                        id: gid,
                        type: group.type,
                        name: group.name,
                        lights: group.lights
                    }
                });
            }
            this.log.info(`created/updated ${pollGroups.length} groups channels`);
        }

        // create scene states
        if (!this.config.ignoreScenes) {
            try {
                const scenes = config.scenes;

                // Create obj to get groupname in constant time
                const groupNames: Record<string, any> = {};
                for (const key in groupIds) {
                    groupNames[groupIds[key]] = key;
                }

                let sceneChannelCreated = false;

                let sceneCounter = 0;
                const sceneNamespace = this.config.useLegacyStructure
                    ? `${this.namespace}.${config.config.name.replace(/[\s.]/g, '_')}`
                    : `${this.namespace}`;
                for (const sceneId of Object.keys(scenes)) {
                    const scene = scenes[sceneId];
                    if (scene.type === 'GroupScene') {
                        if (this.config.ignoreGroups) {
                            continue;
                        }
                        this.log.debug(`Create ${scene.name} in ${groupNames[scene.group]}`);
                        objs.push({
                            _id: `${this.namespace}.${groupNames[scene.group]}.scene_${scene.name
                                .replace(/[\s.]/g, '_')
                                .replace(this.FORBIDDEN_CHARS, '')
                                .toLowerCase()}`,
                            type: 'state',
                            common: {
                                name: `Scene ${scene.name}`,
                                role: 'button',
                                type: 'boolean',
                                read: false,
                                write: true
                            },
                            native: {
                                id: sceneId,
                                group: scene.group
                            }
                        });
                        sceneCounter++;
                    } else {
                        if (!sceneChannelCreated) {
                            objs.push({
                                _id: `${sceneNamespace}.lightScenes`,
                                type: 'channel',
                                common: {
                                    name: 'Light scenes'
                                },
                                native: {}
                            });
                            sceneChannelCreated = true;
                        }

                        this.log.debug(`Create ${scene.name}`);
                        objs.push({
                            _id: `${sceneNamespace}.lightScenes.scene_${scene.name
                                .replace(/[\s.]/g, '_')
                                .replace(this.FORBIDDEN_CHARS, '')
                                .toLowerCase()}`,
                            type: 'state',
                            common: {
                                name: `Scene ${scene.name}`,
                                role: 'button',
                                type: 'boolean',
                                read: false,
                                write: true
                            },
                            native: {
                                id: sceneId
                            }
                        });
                        sceneCounter++;
                    } // edElse
                }
                this.log.info(`created/updated ${sceneCounter} scenes`);
            } catch (e: any) {
                this.log.error(`Error syncing scenes: ${e.message}`);
            }
        }

        // Create/update device
        this.log.info('creating/updating bridge device');
        objs.push({
            _id: this.config.useLegacyStructure
                ? `${this.namespace}.${config.config.name.replace(/[\s.]/g, '_')}`
                : this.namespace,
            type: 'device',
            common: {
                name: config.config.name
            },
            native: config.config
        });

        await this.syncObjects(objs);
    }

    /**
     * Create/Extend given objects
     *
     * @param objs objects which will be created
     */
    async syncObjects(
        objs: (ioBroker.SettableStateObject | ioBroker.SettableChannelObject | ioBroker.SettableDeviceObject)[]
    ): Promise<void> {
        for (const task of objs) {
            try {
                const id = task._id!;
                const obj = await this.getForeignObjectAsync(id);

                // add saturation into enum.functions.color
                if (task.common.role === 'level.color.saturation') {
                    const _enum = await this.getForeignObjectAsync('enum.functions.color');
                    if (_enum?.common?.members?.indexOf(id) === -1) {
                        _enum.common.members.push(id);
                        await this.setForeignObjectNotExists(_enum._id, _enum);
                        if (!obj) {
                            await this.setForeignObjectAsync(id, task);
                        } else {
                            obj.native = task.native;
                            await this.extendForeignObjectAsync(id, obj);
                        }
                    } else if (!obj) {
                        await this.setForeignObjectAsync(id, task);
                    } else {
                        obj.native = task.native;
                        await this.extendForeignObjectAsync(obj._id, obj);
                    }
                } else {
                    // we have deleted common.max so extend will not remove it
                    if (obj?.common) {
                        // preserve the name
                        task.common.name = obj.common.name;
                    }
                    await this.setForeignObjectAsync(id, task);
                }
            } catch (e: any) {
                this.log.error(`Could not sync object ${task._id}: ${e.message}`);
            }
        }
    }

    /**
     * Set given states in db if changed
     *
     * @param states states to set in db
     */
    async syncStates(states: { id: string; val: any }[]): Promise<void> {
        for (const task of states) {
            if (typeof task.val === 'object' && task.val !== null) {
                task.val = task.val.toString();
            }

            // poll guard to prevent too fast polling of recently changed id
            const nameId = task.id.split('.')[this.config.useLegacyStructure ? 3 : 2];
            if (blockedIds[nameId] !== true) {
                try {
                    await this.setForeignStateChangedAsync(
                        task.id.replace(/\s/g, '_'),
                        task.val && typeof task.val === 'object' ? JSON.stringify(task.val) : task.val,
                        true
                    );
                } catch (e: any) {
                    this.log.warn(`Error on syncing state of ${task.id.replace(/\\s/g, '_')}: ${e.message}`);
                }
            } else {
                this.log.debug(`Syncing state of ${nameId} blocked`);
            }
        }
    }

    /**
     * Polls all lights from bridge, creates new groups/lights/sensors and deletes removed ones
     */
    async poll(): Promise<void> {
        // clear polling interval
        if (this.pollingInterval) {
            clearTimeout(this.pollingInterval);
            this.pollingInterval = undefined;
        }

        this.log.debug('Poll all states');

        try {
            const config = await this.api.configuration.getAll();
            await this.setStateChangedAsync('info.connection', true, true);

            if (this.log.level === 'debug' || this.log.level === 'silly') {
                this.log.debug(`Polled config: ${JSON.stringify(config)}`);
            }

            if (config) {
                const values: { id: string; val: any }[] = [];
                const lights = config.lights;
                const sensors = config.sensors;
                const groups = config.groups;

                let noCurrentDevices = Object.keys(lights).length + Object.keys(sensors).length;

                // update sensors
                for (const pollSensor of pollSensors) {
                    const states: Record<string, any> = {};
                    const sensorName = pollSensor.name;

                    let sensor: Record<string, any>;

                    if (sensors[pollSensor.id] !== undefined) {
                        sensor = sensors[pollSensor.id];
                    } else {
                        // detect removed sensors
                        this.log.info(`Sensor ${sensorName} has been removed from bridge`);
                        noDevices--;
                        pollSensors.splice(
                            pollSensors.findIndex(item => item.id === pollSensor.id),
                            1
                        );
                        // if recursive deletion is supported, we delete the object
                        if (this.supportsFeature && this.supportsFeature('ADAPTER_DEL_OBJECT_RECURSIVE')) {
                            this.log.info(
                                `Deleting ${this.namespace}.${
                                    this.config.useLegacyStructure
                                        ? `${config.config.name.replace(/[\s.]/g, '_')}.${sensorName}`
                                        : sensorName
                                }`
                            );
                            this.delObject(
                                `${
                                    this.config.useLegacyStructure
                                        ? `${config.config.name.replace(/[\s.]/g, '_')}.${sensorName}`
                                        : sensorName
                                }`,
                                { recursive: true }
                            );
                        } else {
                            this.log.info(`Recursive deletion not supported by your js-controller, please delete \
                        ${this.namespace}.${
                            this.config.useLegacyStructure
                                ? `${config.config.name.replace(/[\s.]/g, '_')}.${sensorName}`
                                : sensorName
                        } manually`);
                        }
                        continue;
                    }

                    sensor.name = sensorName;

                    const sensorStates = { ...sensor.config, ...sensor.state };
                    for (const stateA of Object.keys(sensorStates)) {
                        states[stateA] = sensorStates[stateA];
                    }

                    if (states.temperature !== undefined) {
                        states.temperature = this.convertTemperature(states.temperature);
                    }
                    for (const [idB, stateB] of Object.entries(states)) {
                        values.push({
                            id: `${this.namespace}.${sensor.name}.${idB}`,
                            val: stateB
                        });
                    }
                }

                // LIGHTS
                for (const pollLight of pollLights) {
                    const states: Record<string, any> = {};
                    const lightName = pollLight.name;

                    let light: Record<string, any>;

                    if (lights[pollLight.id] !== undefined) {
                        light = lights[pollLight.id];
                    } else {
                        // detect removed lights
                        this.log.info(`Light ${lightName} has been removed from bridge`);
                        noDevices--;
                        pollLights.splice(
                            pollLights.findIndex(item => item.id === pollLight.id),
                            1
                        );
                        // if recursive deletion is supported, we delete the object
                        if (this.supportsFeature && this.supportsFeature('ADAPTER_DEL_OBJECT_RECURSIVE')) {
                            this.log.info(
                                `Deleting ${this.namespace}.${
                                    this.config.useLegacyStructure
                                        ? `${config.config.name.replace(/[\s.]/g, '_')}.${lightName}`
                                        : lightName
                                }`
                            );
                            this.delObject(
                                `${
                                    this.config.useLegacyStructure
                                        ? `${config.config.name.replace(/[\s.]/g, '_')}.${lightName}`
                                        : lightName
                                }`,
                                { recursive: true }
                            );
                        } else {
                            this.log.info(`Recursive deletion not supported by your js-controller, please delete \
                        ${this.namespace}.${
                            this.config.useLegacyStructure
                                ? `${config.config.name.replace(/[\s.]/g, '_')}.${lightName}`
                                : lightName
                        } manually`);
                        }
                        continue;
                    }

                    light.name = lightName;

                    if (light.swupdate?.state) {
                        values.push({
                            id: `${this.namespace}.${light.name}.updateable`,
                            val: light.swupdate.state
                        });
                    }

                    for (const stateA of Object.keys(light.state)) {
                        states[stateA] = light.state[stateA];
                    }

                    if (!this.config.ignoreOsram) {
                        if (states.reachable === false && states.bri !== undefined) {
                            states.bri = 0;
                            states.on = false;
                        }
                    }

                    if (states.on === false && states.bri !== undefined) {
                        states.bri = 0;
                    }
                    if (states.xy !== undefined) {
                        const xy = states.xy.toString().split(',');
                        states.xy = states.xy.toString();
                        const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], states.bri / 254);
                        states.r = Math.round(rgb.Red * 254);
                        states.g = Math.round(rgb.Green * 254);
                        states.b = Math.round(rgb.Blue * 254);
                    }
                    if (states.bri !== undefined) {
                        states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
                    }

                    if (states.hue !== undefined) {
                        states.hue = Math.round((states.hue / 65535) * 360);
                    }
                    if (states.ct !== undefined) {
                        // convert color temperature from mired to kelvin
                        states.ct = hueHelper.miredToKelvin(states.ct);
                    }
                    for (const stateB of Object.keys(states)) {
                        values.push({
                            id: `${this.namespace}.${light.name}.${stateB}`,
                            val: states[stateB]
                        });
                    }
                }

                // Create/update groups
                if (!this.config.ignoreGroups) {
                    noCurrentDevices += Object.keys(groups).length;
                    for (const pollGroup of pollGroups) {
                        let group: Record<string, any>;

                        // Group 0 needs extra polling
                        if (pollGroup.id !== '0') {
                            const states: Record<string, any> = {};

                            // save name before a group changing
                            const groupName = pollGroup.name;

                            if (groups[pollGroup.id] !== undefined) {
                                group = groups[pollGroup.id];
                            } else {
                                // detect removed groups
                                this.log.info(`Group ${pollGroup.name} has been removed from bridge`);
                                noDevices--;
                                // if recursive deletion is supported, we delete the object
                                if (this.supportsFeature && this.supportsFeature('ADAPTER_DEL_OBJECT_RECURSIVE')) {
                                    this.log.info(
                                        `Deleting ${this.namespace}.${
                                            this.config.useLegacyStructure
                                                ? `${config.config.name.replace(/[\s.]/g, '_')}.${pollGroup.name}`
                                                : pollGroup.name
                                        }`
                                    );
                                    this.delObject(
                                        `${
                                            this.config.useLegacyStructure
                                                ? `${config.config.name.replace(/[\s.]/g, '_')}.${pollGroup.name}`
                                                : pollGroup.name
                                        }`,
                                        { recursive: true }
                                    );
                                } else {
                                    this.log
                                        .info(`Recursive deletion not supported by your js-controller, please delete \
                                ${this.namespace}.${
                                    this.config.useLegacyStructure
                                        ? `${config.config.name.replace(/[\s.]/g, '_')}.${pollGroup.name}`
                                        : pollGroup.name
                                } manually`);
                                }

                                pollGroups.splice(
                                    pollGroups.findIndex(item => item.id === pollGroup.id),
                                    1
                                );
                                continue;
                            }

                            group.name = groupName;

                            for (const stateA of Object.keys(group.action)) {
                                states[stateA] = group.action[stateA];
                            }
                            if (states.reachable === false && states.bri !== undefined) {
                                states.bri = 0;
                                states.on = false;
                            }
                            if (states.on === false && states.bri !== undefined) {
                                states.bri = 0;
                            }
                            if (states.xy !== undefined) {
                                const xy = states.xy.toString().split(',');
                                states.xy = states.xy.toString();
                                const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], states.bri / 254);
                                states.r = Math.round(rgb.Red * 254);
                                states.g = Math.round(rgb.Green * 254);
                                states.b = Math.round(rgb.Blue * 254);
                            }
                            if (states.bri !== undefined) {
                                states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
                            }

                            if (states.hue !== undefined) {
                                states.hue = Math.round((states.hue / 65535) * 360);
                            }

                            if (states.ct !== undefined) {
                                // convert color temperature from mired to kelvin
                                states.ct = hueHelper.miredToKelvin(states.ct);

                                // some devices send 0 -> infinity (issue #234)
                                if (!isFinite(states.ct)) {
                                    // invalid value we cannot determine the meant value
                                    this.log.debug(
                                        `Cannot determine ct value of "${groupName}", received value "${states.ct}"`
                                    );
                                    delete states.ct;
                                }
                            }

                            // The next two are entertainment states
                            if (group.class) {
                                states.class = group.class;
                            }

                            if (group.stream?.active !== undefined) {
                                states.activeStream = group.stream.active;
                            }

                            for (const stateB of Object.keys(states)) {
                                values.push({
                                    id: `${this.namespace}.${group.name}.${stateB}`,
                                    val: states[stateB]
                                });
                            }

                            // set anyOn state
                            values.push({
                                id: `${this.namespace}.${group.name}.anyOn`,
                                val: group.state['any_on']
                            });

                            // set allOn state
                            values.push({
                                id: `${this.namespace}.${group.name}.allOn`,
                                val: group.state['all_on']
                            });
                        } else {
                            // poll the 0 - ALL group
                            await this.updateGroupState(pollGroup);
                        }
                    }
                }
                await this.syncStates(values);

                // check if new devices detected
                if (noCurrentDevices > noDevices) {
                    // we have more devices then expected (no of devices at start - deleted ones)
                    // Note, that this can only be a well working non cpu-intensive heuristic,
                    // because if 1 sensor removed which are not part of the adapter (count not decreased)
                    // and 1 real sensor added, between the same polling, the count will stay the same, however should be a super edge case
                    // for now we restart - TODO: split up connect and object creation function and call w/o restart
                    this.log.info('New devices detected - initializing restart');
                    return void this.restart();
                } else {
                    noDevices = noCurrentDevices;
                }
            }
        } catch (e: any) {
            await this.setStateChangedAsync('info.connection', false, true);
            this.log.error(`Could not poll all: ${e.message || e}`);
        }

        if (!this.pollingInterval) {
            this.pollingInterval = this.setTimeout(() => this.poll(), this.config.pollingInterval * 1_000);
        }
    }

    /**
     * Convert the temperature reading
     *
     * @param value read temperature
     */
    convertTemperature(value: any): number {
        if (value !== null) {
            value = value.toString();
            const sign = value.startsWith('-') ? '-' : '+';
            value = value.startsWith('-') ? value.substring(1) : value;
            const last = value.substring(value.length - 2, value.length);
            const first = value.substring(0, value.length - 2);
            value = `${sign}${first}.${last}`;
        } else {
            value = '0';
        }
        return parseFloat(value);
    }
}

// Export the constructor in compact mode
if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions>) => new Hue(options);
} else {
    // otherwise start the instance directly
    new Hue();
}
