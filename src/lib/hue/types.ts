/**
 * Type definitions for the Philips Hue CLIP API v2.
 *
 * Only the parts used by this adapter are modelled. Unknown properties are tolerated,
 * because the bridge firmware adds new fields regularly.
 */

/** Reference to another resource */
export interface ResourceIdentifier {
    rid: string;
    rtype: string;
}

/** Properties shared by every resource */
export interface BaseResource {
    /** Unique id (UUID) of the resource */
    id: string;
    /** Legacy API v1 id, e.g. `/lights/5` */
    id_v1?: string;
    type: string;
    /** Owning resource, e.g. the device of a light service */
    owner?: ResourceIdentifier;
    [key: string]: unknown;
}

export interface XY {
    x: number;
    y: number;
}

export interface Gamut {
    red: XY;
    green: XY;
    blue: XY;
}

export interface DeviceResource extends BaseResource {
    type: 'device';
    product_data: {
        model_id: string;
        manufacturer_name: string;
        product_name: string;
        product_archetype: string;
        certified: boolean;
        software_version: string;
        hardware_platform_type?: string;
    };
    metadata: {
        name: string;
        archetype: string;
    };
    services: ResourceIdentifier[];
}

export interface LightResource extends BaseResource {
    type: 'light';
    owner: ResourceIdentifier;
    metadata?: {
        name?: string;
        archetype?: string;
    };
    on: {
        on: boolean;
    };
    dimming?: {
        brightness: number;
        min_dim_level?: number;
    };
    color_temperature?: {
        mirek: number | null;
        mirek_valid: boolean;
        mirek_schema?: {
            mirek_minimum: number;
            mirek_maximum: number;
        };
    };
    color?: {
        xy: XY;
        gamut?: Gamut;
        gamut_type?: 'A' | 'B' | 'C' | 'other';
    };
    alert?: {
        action_values: string[];
    };
    effects?: {
        effect?: string;
        status?: string;
        effect_values?: string[];
        status_values?: string[];
    };
    mode?: 'normal' | 'streaming';
}

export interface GroupedLightResource extends BaseResource {
    type: 'grouped_light';
    owner: ResourceIdentifier;
    on?: {
        on: boolean;
    };
    dimming?: {
        brightness: number;
    };
}

export interface GroupResource extends BaseResource {
    type: 'room' | 'zone' | 'bridge_home';
    metadata?: {
        name: string;
        archetype?: string;
    };
    children: ResourceIdentifier[];
    services: ResourceIdentifier[];
}

export type SceneActiveState = 'inactive' | 'static' | 'dynamic_palette';

export interface SceneResource extends BaseResource {
    type: 'scene';
    metadata: {
        name: string;
    };
    group: ResourceIdentifier;
    status?: {
        active: SceneActiveState;
    };
}

export interface SmartSceneResource extends BaseResource {
    type: 'smart_scene';
    metadata: {
        name: string;
    };
    group: ResourceIdentifier;
    state: 'active' | 'inactive';
}

export interface EntertainmentConfigurationResource extends BaseResource {
    type: 'entertainment_configuration';
    metadata: {
        name: string;
    };
    status: 'active' | 'inactive';
}

export interface BehaviorInstanceResource extends BaseResource {
    type: 'behavior_instance';
    metadata: {
        name: string;
    };
    enabled: boolean;
}

export interface MotionResource extends BaseResource {
    type: 'motion' | 'camera_motion';
    owner: ResourceIdentifier;
    enabled: boolean;
    motion: {
        motion?: boolean;
        motion_valid?: boolean;
        motion_report?: {
            changed: string;
            motion: boolean;
        };
    };
}

export interface TemperatureResource extends BaseResource {
    type: 'temperature';
    owner: ResourceIdentifier;
    enabled: boolean;
    temperature: {
        temperature?: number;
        temperature_valid?: boolean;
        temperature_report?: {
            changed: string;
            temperature: number;
        };
    };
}

export interface LightLevelResource extends BaseResource {
    type: 'light_level';
    owner: ResourceIdentifier;
    enabled: boolean;
    light: {
        light_level?: number;
        light_level_valid?: boolean;
        light_level_report?: {
            changed: string;
            light_level: number;
        };
    };
}

export type ButtonEvent =
    'initial_press' | 'repeat' | 'short_release' | 'long_release' | 'double_short_release' | 'long_press';

export interface ButtonResource extends BaseResource {
    type: 'button';
    owner: ResourceIdentifier;
    metadata: {
        control_id: number;
    };
    button?: {
        last_event?: ButtonEvent;
        button_report?: {
            updated: string;
            event: ButtonEvent;
        };
    };
}

export interface RotaryEvent {
    action: 'start' | 'repeat';
    rotation: {
        direction: 'clock_wise' | 'counter_clock_wise';
        steps: number;
        duration: number;
    };
}

export interface RelativeRotaryResource extends BaseResource {
    type: 'relative_rotary';
    owner: ResourceIdentifier;
    relative_rotary?: {
        last_event?: RotaryEvent;
        rotary_report?: RotaryEvent & {
            updated: string;
        };
    };
}

export interface ContactResource extends BaseResource {
    type: 'contact';
    owner: ResourceIdentifier;
    enabled: boolean;
    contact_report?: {
        changed: string;
        state: 'contact' | 'no_contact';
    };
}

export interface TamperResource extends BaseResource {
    type: 'tamper';
    owner: ResourceIdentifier;
    tamper_reports: {
        changed: string;
        source: string;
        state: 'tampered' | 'not_tampered';
    }[];
}

export interface DevicePowerResource extends BaseResource {
    type: 'device_power';
    owner: ResourceIdentifier;
    power_state: {
        battery_state?: 'normal' | 'low' | 'critical';
        battery_level?: number;
    };
}

export interface ZigbeeConnectivityResource extends BaseResource {
    type: 'zigbee_connectivity';
    owner: ResourceIdentifier;
    status: 'connected' | 'disconnected' | 'connectivity_issue' | 'unidirectional_incoming';
}

export interface BridgeResource extends BaseResource {
    type: 'bridge';
    bridge_id: string;
}

/** Any resource returned by the bridge */
export type HueResource = BaseResource;

/** Generic response envelope of the CLIP v2 API */
export interface HueResponse<T> {
    errors: { description: string }[];
    data: T[];
}

/** A single message received via the event stream */
export interface HueEvent {
    id: string;
    creationtime: string;
    type: 'add' | 'update' | 'delete' | 'error';
    data: HueResource[];
}
