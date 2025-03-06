"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HueV2Client = void 0;
const axios_1 = __importDefault(require("axios"));
const node_https_1 = __importDefault(require("node:https"));
class HueV2Client {
    constructor(props) {
        this.user = props.user;
        this.baseUrl = `https://${props.address}:443/clip/v2`;
        this.restClient = axios_1.default.create({
            httpsAgent: new node_https_1.default.Agent({ rejectUnauthorized: false })
        });
    }
    /**
     * Get all devices from bridge
     */
    async getDevices() {
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
    async getScenes() {
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
    async getBehaviorScripts() {
        const res = await this.restClient.get(`${this.baseUrl}/resource/behavior_script`, {
            headers: {
                'hue-application-key': this.user
            }
        });
        return res.data;
    }
    async getContactSensors() {
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
    async getDevice(uuid) {
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
    async getDevicePower(uuid) {
        const res = await this.restClient.get(`${this.baseUrl}/resource/device_power/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });
        return res.data;
    }
    /**
     * Get all smart scenes
     */
    async getSmartScenes() {
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
    async setSmartSceneState(uuid, state) {
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
    async startSmartScene(uuid) {
        return this.setSmartSceneState(uuid, 'activate');
    }
    /**
     * Stop a smart scene
     *
     * @param uuid the UUID of the smart scene
     */
    async stopSmartScene(uuid) {
        return this.setSmartSceneState(uuid, 'deactivate');
    }
    /**
     * Get room for given uuid
     * @param uuid uuid of the room
     */
    async getRoom(uuid) {
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
    async getZone(uuid) {
        const res = await this.restClient.get(`${this.baseUrl}/resource/zone/${uuid}`, {
            headers: {
                'hue-application-key': this.user
            }
        });
        return res.data;
    }
}
exports.HueV2Client = HueV2Client;
//# sourceMappingURL=v2-client.js.map