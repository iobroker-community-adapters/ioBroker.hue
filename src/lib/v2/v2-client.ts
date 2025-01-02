import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'node:https';

export type ActivationState = 'active' | 'inactive';
export type SceneActivationState = 'activate' | 'deactivate';

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
    id: string;
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

export interface Resource {
    rid: string;
    rtype: string;
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
     * @param uuid uuid of the smart scene
     * @param state the activation state
     */
    private async setSmartSceneState(uuid: string, state: SceneActivationState): Promise<Response<Resource>> {
        const res: AxiosResponse<Response<SmartSceneData>> = await this.restClient.get(
            `${this.baseUrl}/resource/smart_scene/${uuid}`,
            {
                headers: {
                    'hue-application-key': this.user
                }
            }
        );

        const sceneData = res.data.data[0];
        const putData = {
            metadata: {},
            type: sceneData.type,
            week_timeslots: sceneData.week_timeslots,
            transition_duration: sceneData.transition_duration,
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
