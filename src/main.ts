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

interface BridgeUpdate {
    dimming?: { brightness: number };
    id: string;
    id_v1: `/${string}/${number}`;
    owner: { rid: string; rtype: string };
    type: 'grouped_light' | 'light' | 'temperature' | 'motion' | 'light_level' | 'zigbee_connectivity';
    /** if type is motion */
    motion?: { motion: boolean; motion_report: { changed: string; motion: boolean }; motion_valid: boolean };
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
    /** For type zigbee_connectivity */
    status?: 'connected' | 'connectivity_issue';
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

const SUPPORTED_SENSORS = ['ZLLSwitch', 'ZGPSwitch', 'Daylight', 'ZLLTemperature', 'ZLLPresence', 'ZLLLightLevel'];
const SOFTWARE_SENSORS = ['CLIPGenericStatus', 'CLIPGenericFlag'];

class Hue extends utils.Adapter {
    /** Timeout for next polling */
    private pollingInterval?: NodeJS.Timeout;
    /** Timeout for reconnect */
    private reconnectTimeout?: NodeJS.Timeout;

    /** Instance of the Hue API */
    private api!: Api;
    /** Instance of the Hue push client */
    private pushClient: any;

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

        if (this.config.polling) {
            this.poll();
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
                    // @ts-expect-error obj.message can be anything
                    const res = await this.browse(obj.message);
                    if (obj.callback) {
                        // @ts-expect-error need to check
                        await this.sendToAsync(obj.from, obj.command, res, obj.callback);
                    }
                    break;
                }
                case 'createUser': {
                    const res = await this.createUser(obj.message as string);
                    if (obj.callback) {
                        // @ts-expect-error need to check
                        await this.sendToAsync(obj.from, obj.command, res, obj.callback);
                    }
                    break;
                }
                default:
                    this.log.warn(`Unknown command: ${obj.command}`);
                    if (obj.callback) {
                        // @ts-expect-error need to check
                        await this.sendToAsync(obj.from, obj.command, obj.message, obj.callback);
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

        if (dp.startsWith('scene_')) {
            try {
                // it's a scene -> get scene id to start it
                const obj = await this.getForeignObjectAsync(id);
                const groupState = new v3.lightStates.GroupLightState();

                if (!obj) {
                    throw new Error(`Object "${id}" is not existing`);
                }

                groupState.scene(obj.native.id);

                await this.api.groups.setGroupState(0, groupState);

                this.log.info(`Started scene: ${obj.common.name}`);
            } catch (e: any) {
                this.log.error(`Could not start scene: ${e.message || e}`);
            }
            return;
        }

        // check if its a sensor
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
                this.api.groups.enableStreaming(groupIds[id]);
            } else {
                //turn streaming off
                this.log.debug(`Disable streaming of ${id} (${groupIds[id]})`);
                this.api.groups.disableStreaming(groupIds[id]);
            }
            return;
        }

        // anyOn and allOn will just act like on dp
        if (dp === 'anyOn' || dp === 'allOn') {
            dp = 'on';
        }

        const fullIdBase = `${tmp.join('.')}.`;

        // if .on changed instead change .bri to 254 or 0, except it is a switch which has no brightness
        let bri = 0;
        if (
            dp === 'on' &&
            !this.config.nativeTurnOffBehaviour &&
            !(channelObj && channelObj.common && channelObj.common.role === 'switch')
        ) {
            bri = state.val ? 254 : 0;
            this.setState([id, 'bri'].join('.'), { val: bri, ack: false });
            return;
        }
        // if .level changed instead change .bri to level.val*254
        if (dp === 'level' && typeof state.val === 'number') {
            bri = Math.max(Math.min(Math.round(state.val * 2.54), 254), 0);
            this.setState([id, 'bri'].join('.'), { val: bri, ack: false });
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
                    // we need to get the id of the scene
                    const sceneObj = await this.getObjectAsync(`${channelId}.scene_${commands.scene.toLowerCase()}`);

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
                            ls.bri = Math.min(254, Math.max(0, Math.round(parseInt(commands[command]) * 2.54)));
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

        // get lightState
        let obj;
        try {
            obj = await this.getObjectAsync(id);
        } catch (e: any) {
            this.log.error(`Could not get object "${id}" on stateChange: ${e.message}`);
            return;
        }

        // maybe someone emitted a state change for a non-existing device via script
        if (!obj?.common?.role) {
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
                Object.prototype.hasOwnProperty.call(obj.native, 'modelid') ? obj.native.modelid.trim() : 'default'
            );
            ls.bri = xyb.b;
            ls.xy = `${xyb.x},${xyb.y}`;
        }

        // create lightState from ls and check values
        let lightState = /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(obj.common.role)
            ? new v3.lightStates.GroupLightState()
            : new v3.lightStates.LightState();

        if (parseInt(ls.bri) > 0) {
            const bri = Math.min(254, ls.bri);
            if (isNaN(bri)) {
                throw new Error(`Error on converting value for bri: ${bri} - ${ls.bri} (${typeof ls.bri})`);
            }
            lightState = lightState.bri(bri);
            finalLS.bri = bri;
            // if nativeTurnOnOffBehaviour -> only turn group on if no lamp is on yet on brightness change
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
                Object.prototype.hasOwnProperty.call(obj.native, 'modelid') ? obj.native.modelid.trim() : 'default'
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

            finalLS.ct = Math.max(2200, Math.min(6500, ls.ct));
            // convert kelvin to mired
            finalLS.ct = Math.round(1e6 / finalLS.ct);

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
            alls.ct = 500 - 153 - ((alls.ct - 2200) / (6500 - 2200)) * (500 - 153) + 153;

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

        // if dp is on, and we use native turn off behaviour only set the lightState
        if (dp === 'on' && this.config.nativeTurnOffBehaviour) {
            // todo: this is somehow dirty but the code above is messy -> integrate above in a more clever way later
            lightState = /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(obj.common.role)
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

        if (!this.config.ignoreGroups && /(LightGroup)|(Room)|(Zone)|(Entertainment)/g.test(obj.common.role)) {
            // log final changes / states
            this.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);
            try {
                await this.api.groups.setGroupState(groupIds[id], lightState);
                await this.updateGroupState({
                    id: groupIds[id],
                    name: obj._id.substr(this.namespace.length + 1)
                });
                this.log.debug(`updated group state (${groupIds[id]}) after change`);
            } catch (e: any) {
                this.log.error(`Could not set GroupState of ${obj.common.name}: ${e.message}`);
            }
        } else if (obj.common.role === 'switch') {
            if (Object.prototype.hasOwnProperty.call(finalLS, 'on')) {
                finalLS = { on: finalLS.on };
                // log final changes / states
                this.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);

                lightState = new v3.lightStates.LightState();
                lightState.on(finalLS.on);
                try {
                    await this.api.lights.setLightState(channelIds[id], lightState);
                    await this.updateLightState({
                        id: channelIds[id],
                        name: obj._id.substr(this.namespace.length + 1)
                    });
                    this.log.debug(`updated LightState (${channelIds[id]}) after change`);
                } catch (e: any) {
                    this.log.error(`Could not set LightState of ${obj.common.name}: ${e.message}`);
                }
            } else {
                this.log.warn('invalid switch operation');
            }
        } else {
            // log final changes / states
            this.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);

            try {
                await this.api.lights.setLightState(channelIds[id], lightState);
                await this.updateLightState({
                    id: channelIds[id],
                    name: obj._id.substr(this.namespace.length + 1)
                });
                this.log.debug(`updated LightState (${channelIds[id]}) after change`);
            } catch (e: any) {
                this.log.error(`Could not set LightState of ${obj.common.name}: ${e.message}`);
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

        return bridges;
    }

    /**
     * Create user on the bridge by given Ip
     *
     * @param ip - ip address of the bridge
     */
    async createUser(ip: string): Promise<Record<string, any>> {
        const deviceName = 'ioBroker.hue';
        try {
            const api = this.config.ssl
                ? await v3.api.createLocal(ip, this.config.port).connect()
                : // @ts-expect-error third party types are incorrect
                  await v3.api.createInsecureLocal(ip, this.config.port).connect();

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
                states.hue = Math.round((states.hue / 65535) * 360);
            }
            if (states.ct !== undefined) {
                // convert color temperature from mired to kelvin
                states.ct = Math.round(1e6 / states.ct);
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
                // convert color temperature from mired to kelvin
                states.ct = Math.round(1e6 / states.ct);
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
<<<<<<< HEAD
     * Create a push connection to the Hue bridge, to listen to updates in near real-time
     */
    createPushConnection(): void {
        // @ts-expect-error lib export is wrong
        this.pushClient = new HuePushClient({ ip: this.config.bridge, user: this.config.user });

        this.pushClient.addEventListener('open', () => {
            this.log.info('Push connection established');
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
    handleUpdate(update: BridgeUpdate): void {
        this.log.debug(`New push connection update: ${JSON.stringify(update)}`);

        const id = parseInt(update.id_v1.split('/')[2]);

        if (update.type === 'light') {
            this.handleLightUpdate(id, update);
            return;
        }

        if (update.type === 'grouped_light') {
            this.handleGroupUpdate(id, update);
            return;
        }

        if (update.type === 'motion' || update.type === 'temperature' || update.type === 'light_level') {
            this.handleSensorUpdate(id, update);
            return;
        }

        if (update.type === 'zigbee_connectivity') {
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
    handleSensorUpdate(id: number, update: BridgeUpdate): void {
        const channelName = this.getSensorChannelById(id);

        if (update.temperature?.temperature_valid) {
            this.setState(`${channelName}.temperature`, update.temperature.temperature, true);
        }

        if (update.motion?.motion_valid) {
            this.setState(`${channelName}.presence`, update.motion.motion, true);
        }

        if (update.light?.light_level_valid) {
            this.setState(`${channelName}.lightlevel`, update.light.light_level, true);
        }
    }

    /**
     * Handle light specific update
     *
     * @param id id of the light
     * @param update the update sent by bridge
     */
    handleLightUpdate(id: number, update: BridgeUpdate): void {
        const channelName = this.getLightChannelById(id);

        if (update.on) {
            this.setState(`${channelName}.on`, update.on.on, true);
        }
    }

    /**
     * Handle group specific update
     *
     * @param id id of the group
     * @param update the update sent by bridge
     */
    handleGroupUpdate(id: number, update: BridgeUpdate): void {
        const channelName = this.getGroupChannelById(id);

        if (update.on) {
            this.setState(`${channelName}.on`, update.on.on, true);
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
    getGroupChannelById(id: number): string {
        const idx = Object.values(groupIds).indexOf(id.toString());

        return Object.keys(groupIds)[idx];
    }

    /**
=======
>>>>>>> 7dcd9eb0021aff8763a97d55e0f82468f6fcc8a5
     * Connects to the bridge and creates the initial objects
     */
    async connect(): Promise<void> {
        let config;
        try {
            if (this.config.ssl) {
                this.log.debug(`Using https to connect to ${this.config.bridge}:${this.config.port}`);
                this.api = await v3.api.createLocal(this.config.bridge, this.config.port).connect(this.config.user);
            } else {
                this.log.debug(`Using insecure http to connect to ${this.config.bridge}:${this.config.port}`);
                this.api = await v3.api
                    .createInsecureLocal(this.config.bridge, this.config.port)
                    // @ts-expect-error should be correct -> third party types wrong
                    .connect(this.config.user);
            }

            this.createPushConnection();

            config = await this.api.configuration.getAll();
        } catch (e: any) {
            this.log.error(e.message || e);
        }

        if (!config?.config) {
            this.log.warn(`Could not get configuration from HUE bridge (${this.config.bridge}:${this.config.port})`);
            this.reconnectTimeout = setTimeout(() => {
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
        const objs: ioBroker.SettableObject[] = [];

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
                let value = light.state[state];
                const objId = `${channelName}.${state}`;

                const lobj: ioBroker.SettableStateObject = {
                    _id: `${this.namespace}.${objId.replace(/\s/g, '_')}`,
                    type: 'state',
                    common: {
                        name: objId,
                        read: true,
                        write: true,
                        role: 'state'
                    },
                    native: {
                        id: lid
                    }
                };

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
                            // often max: 454 or 500, min: 153
                            ctObj = light._populationData.capabilities.control.ct || ctObj;
                            //fix invalid bridge values
                            if (ctObj.min === 0) {
                                ctObj.min = 153;
                            }
                            if (ctObj.max === 65535 || ctObj.max === 0) {
                                ctObj.max = 500;
                            }
                        } catch {
                            // ignore
                        }
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.temperature';
                        lobj.common.unit = '°K';
                        lobj.common.min = Math.round(1e6 / ctObj.max); // this way, because with higher Kelvin -> smaller Mired
                        lobj.common.max = Math.round(1e6 / ctObj.min);
                        value = Math.round(1e6 / value);
                        if (!isFinite(value)) {
                            // issue #234
                            // invalid value we cannot determine the meant value, fallback to max
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
                    pointsymbol: light.pointsymbol
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
                            // mired to kelvin
                            group.action[action] = Math.round(1e6 / group.action[action]);
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
    async syncObjects(objs: ioBroker.SettableObject[]): Promise<void> {
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
                        // if recursive deletion is supported we delete the object
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
                        // if recursive deletion is supported we delete the object
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
                        states.ct = Math.round(1e6 / states.ct);

                        // some devices send 0 -> infinity (issue #234)
                        if (!isFinite(states.ct)) {
                            // invalid value we cannot determine the meant value
                            this.log.debug(
                                `Cannot determine ct value of "${light.name}", received value "${states.ct}"`
                            );
                            delete states.ct;
                        }
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

                            // save name before changing group
                            const groupName = pollGroup.name;

                            if (groups[pollGroup.id] !== undefined) {
                                group = groups[pollGroup.id];
                            } else {
                                // detect removed groups
                                this.log.info(`Group ${pollGroup.name} has been removed from bridge`);
                                noDevices--;
                                // if recursive deletion is supported we delete the object
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
                                    pollGroups.findIndex(item => item.id === group.id),
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
                                states.ct = Math.round(1e6 / states.ct);

                                // some devices send 0 -> infinity (issue #234)
                                if (!isFinite(states.ct)) {
                                    // invalid value we cannot determine the meant value
                                    this.log.debug(
                                        `Cannot determine ct value of "${groupName}", received value "${states.ct}"`
                                    );
                                    delete states.ct;
                                }
                            }

                            // Next two are entertainment states
                            if (group.class) {
                                states.class = group.class;
                            }

                            if (group.stream && group.stream.active !== undefined) {
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
                            this.updateGroupState(pollGroup);
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
            this.pollingInterval = setTimeout(() => this.poll(), this.config.pollingInterval * 1_000);
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
