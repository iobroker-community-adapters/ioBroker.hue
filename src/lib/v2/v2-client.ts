import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import { Branded } from '../types';

export type ActivationState = 'active' | 'inactive';
export type SceneActivationState = 'activate' | 'deactivate';
export type HueUuid = Branded<string, 'uuid'>;

export interface HueV2ClientProps {
    /** User to authenticate at the API */
    user: string;
    /** IP address of the bridge */
    address: string;
}
export interface HueResponseError {
    /** Human-readable description of the error */
    description: string;
}

export interface Response<T> {
    /** Empty array if no errors present */
    errors: HueResponseError[];
    data: T[];
}

export interface BaseData {
    /** The uuid of the device  */
    id: HueUuid;
    /** The device id for Hue API v1 */
    id_v1?: string;
    /** Type of the data */
    type: string;
}

export interface DeviceData extends BaseData {
    /** Product data for this device */
    product_data: DeviceProductData;
    metadata: DeviceMetaData;
    identify?: Record<string, unknown>;
    usertest?: DeviceUserTest;
    services: Resource[];
    type: 'device';
}

export interface DeviceUserTest {
    status: string;
    usertest: boolean;
}

export interface DeviceProductData {
    model_id: string;
    manufacturer_name: string;
    product_name: string;
    product_archetype: string;
    certified: boolean;
    software_version: string;
    hardware_platform_type?: string;
}

export type BatteryState = 'normal' | 'low' | 'critical';

export interface DevicePowerData extends BaseData {
    power_state: {
        /**
         *  Status of the power source of a device, only for battery powered devices.
         *  normal – battery level is sufficient – low – battery level low, some features (e.g. software update) might stop working, please change battery soon – critical – battery level critical, device can fail any moment
         */
        battery_state: BatteryState;
        /**
         * Integer, the current battery state in percent, only for battery powered devices.
         */
        battery_level: number;
    };
}

export type TamperState = 'tampered' | 'not_tampered';
export interface TamperReport {
    /**
     * Last time the value of this property is changed.
     */
    changed: string;
    /**
     * Source of tamper and time expired since last change of tamper-state.
     */
    source: 'battery_door';
    /**
     * One of `tampered` and `not_tampered` are the state of tamper after last change of tamper_state.
     */
    state: TamperState;
}

export interface TamperData extends BaseData {
    tamper_reports: TamperReport[];
}

export type ResourceType =
    | 'zigbee_connectivity'
    | 'contact'
    | 'tamper'
    | 'device_power'
    | 'device_software_update'
    | 'room';

export interface Resource {
    rid: HueUuid;
    rtype: ResourceType;
}

export interface DeviceMetaData {
    name: string;
    archetype: string;
}

export interface SceneData extends BaseData {
    actions: SceneAction[];
    palette: ScenePalette;
    recall: Record<string, unknown>;
    metadata: SceneMetadata;
    group: Resource;
    speed: number;
    auto_dynamic: boolean;
    status: SceneStatus;
    type: 'scene';
}

export interface SceneStatus {
    active: ActivationState;
    last_recall?: string;
}

export interface SceneMetadata {
    name: string;
    image?: Resource;
    appdata?: string;
}

export interface ScenePalette {
    color: unknown[];
    dimming: unknown[];
    color_temperature: unknown[];
    effects: unknown[];
    effects_v2: unknown[];
}

export interface SceneAction {
    target: Resource;
    action: Command;
}

export interface Command {
    on: OnCommand;
    dimming?: DimmingCommand;
    color?: ColorCommand;
    color_temperature?: ColorTemperatureCommand;
}

export interface ColorTemperatureCommand {
    mirek: number;
}

export interface OnCommand {
    on: boolean;
}

export interface DimmingCommand {
    brightness: number;
}

export interface ColorCommand {
    xy: XYValue;
}

export interface XYValue {
    x: number;
    y: number;
}

export interface BehaviorScriptData extends BaseData {
    type: 'behavior_script';
    description: string;
    configuration_schema: BehaviorScriptReference;
    trigger_schema: BehaviorScriptReference;
    state_schema: BehaviorScriptReference;
    version: string;
    metadata: BehaviorScriptMetaData;
    supported_features: unknown[];
    max_number_instances?: number;
}

export interface BehaviorScriptMetaData {
    name: string;
    category: string;
}

export interface BehaviorScriptReference {
    $ref?: string;
}

export interface ContactReport {
    changed: string;
    state: 'contact' | 'no_contact';
}

export interface ContactSensorData extends BaseData {
    type: 'contact';
    owner: Resource;
    enabled: boolean;
    contact_report: ContactReport;
}

export interface SmartSceneData extends BaseData {
    type: 'smart_scene';
    metadata: SmartSceneMetaData;
    group: Resource;
    week_timeslots: SmartSceneWeekTimeslot[];
    transition_duration: number;
    active_timeslot: SmartSceneTimeslot;
    state: ActivationState;
}

export interface SmartSceneWeekTimeslot {
    timeslots: SmartSceneWeekTimeslotEntry[];
    recurrence: string[];
}

export interface SmartSceneWeekTimeslotEntry {
    start_time: SmartSceneStartTime;
    target: Resource;
}

export interface SmartSceneStartTime {
    kind: 'time';
    time: SmartSceneTime;
}

export interface SmartSceneTime {
    hour: number;
    minute: number;
    second: number;
}

export interface SmartSceneTimeslot {
    timeslot_id: number;
    weekday: string;
}

export interface SmartSceneMetaData {
    name: string;
    image: Resource;
}

export interface RoomData extends BaseData {
    children: Resource[];
    services: Resource[];
    metadata: RoomMetaData;
    type: 'room';
}

export interface RoomMetaData {
    name: string;
    archetype: string;
}

export interface ZoneData extends BaseData {
    children: Resource[];
    services: Resource[];
    metadata: ZoneMetaData;
    type: 'room';
}

export interface ZoneMetaData {
    name: string;
    archetype: string;
}

export class HueV2Client {
    /** The user to authenticate at the API */
    private readonly user: string;
    /** Base address of the bridge */
    private readonly baseUrl: string;
    /** Axios client */
    private restClient: AxiosInstance;

    constructor(props: HueV2ClientProps) {
        this.user = props.user;
        this.baseUrl = `https://${props.address}:443/clip/v2`;
        this.restClient = axios.create({
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
    }

    /**
     * Get all devices from bridge
     */
    async getDevices(): Promise<Response<DeviceData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/device`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get all existing scenes from the bridge
     */
    async getScenes(): Promise<Response<SceneData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/scene`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get all behavior scripts from the Hue bridge
     */
    async getBehaviorScripts(): Promise<Response<BehaviorScriptData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/behavior_script`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get all contact sensors from bridge
     */
    async getContactSensors(): Promise<Response<ContactSensorData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/contact`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get device data for single device by UUID
     *
     * @param uuid uuid of the device
     */
    async getDevice(uuid: HueUuid): Promise<Response<DeviceData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/device/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get device data power data for single resource by UUID
     *
     * @param uuid uuid of the device power resource
     */
    async getDevicePower(uuid: HueUuid): Promise<Response<DevicePowerData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/device_power/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get tamper state for a single resource by UUID
     *
     * @param uuid uuid of the device power resource
     */
    async getTamperState(uuid: HueUuid): Promise<Response<TamperData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/tamper/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get all smart scenes
     */
    async getSmartScenes(): Promise<Response<SmartSceneData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/smart_scene`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Activate or deactivate a smart scene
     *
     * @param uuid uuid of the smart scene
     * @param state the activation state
     */
    private async setSmartSceneState(uuid: string, state: SceneActivationState): Promise<Response<Resource>> {
        const putData = {
            recall: {
                action: state
            }
        };

        const res2 = await this.restClient.put(`${this.baseUrl}/resource/smart_scene/${uuid}`, putData, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res2.data;
    }

    /**
     * Start a smart scene
     *
     * @param uuid the UUID of the smart scene
     */
    async startSmartScene(uuid: string): Promise<Response<Resource>> {
        return this.setSmartSceneState(uuid, 'activate');
    }

    /**
     * Stop a smart scene
     *
     * @param uuid the UUID of the smart scene
     */
    async stopSmartScene(uuid: string): Promise<Response<Resource>> {
        return this.setSmartSceneState(uuid, 'deactivate');
    }

    /**
     * Get room for given uuid
     * @param uuid uuid of the room
     */
    async getRoom(uuid: string): Promise<Response<RoomData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/room/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }

    /**
     * Get zone for given uuid
     * @param uuid uuid of the zone
     */
    async getZone(uuid: string): Promise<Response<ZoneData>> {
        const res = await this.restClient.get(`${this.baseUrl}/resource/zone/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });

        return res.data;
    }
}
