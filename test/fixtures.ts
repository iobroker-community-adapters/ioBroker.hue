import type { HueResource } from '../src/lib/hue/types';

/**
 * A small but realistic bridge setup:
 * - color light "Desk" (device with light + zigbee_connectivity)
 * - white light "Hall" (dimming only)
 * - dimmer switch "Switch" (4 buttons, battery, connectivity)
 * - motion sensor "Corridor sensor" (motion, temperature, light level, battery)
 * - contact sensor "Door" (contact, tamper)
 * - tap dial "Dial" (button + relative rotary)
 * - room "Living room" with Desk and Hall, zone "Work" with Desk, bridge home
 * - two scenes and a smart scene in the living room
 * - an entertainment area and an automation
 */
export function createFixture(): HueResource[] {
    const resources: HueResource[] = [
        {
            id: 'dev-desk',
            type: 'device',
            product_data: {
                model_id: 'LCA001',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue color lamp',
                product_archetype: 'sultan_bulb',
                certified: true,
                software_version: '1.104.2',
            },
            metadata: { name: 'Desk', archetype: 'sultan_bulb' },
            services: [
                { rid: 'light-desk', rtype: 'light' },
                { rid: 'zb-desk', rtype: 'zigbee_connectivity' },
            ],
        },
        {
            id: 'light-desk',
            type: 'light',
            owner: { rid: 'dev-desk', rtype: 'device' },
            on: { on: true },
            dimming: { brightness: 49.8, min_dim_level: 0.2 },
            color_temperature: {
                mirek: 366,
                mirek_valid: true,
                mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 },
            },
            color: {
                xy: { x: 0.4573, y: 0.41 },
                gamut: { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } },
                gamut_type: 'C',
            },
            alert: { action_values: ['breathe'] },
            effects: { status: 'no_effect', effect_values: ['no_effect', 'candle', 'fire'] },
            mode: 'normal',
        },
        {
            id: 'zb-desk',
            type: 'zigbee_connectivity',
            owner: { rid: 'dev-desk', rtype: 'device' },
            status: 'connected',
        },
        {
            id: 'dev-hall',
            type: 'device',
            product_data: {
                model_id: 'LWA001',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue white lamp',
                product_archetype: 'classic_bulb',
                certified: true,
                software_version: '1.104.2',
            },
            metadata: { name: 'Hall', archetype: 'classic_bulb' },
            services: [
                { rid: 'light-hall', rtype: 'light' },
                { rid: 'zb-hall', rtype: 'zigbee_connectivity' },
            ],
        },
        {
            id: 'light-hall',
            type: 'light',
            owner: { rid: 'dev-hall', rtype: 'device' },
            on: { on: false },
            dimming: { brightness: 100 },
            alert: { action_values: ['breathe'] },
            mode: 'normal',
        },
        {
            id: 'zb-hall',
            type: 'zigbee_connectivity',
            owner: { rid: 'dev-hall', rtype: 'device' },
            status: 'connectivity_issue',
        },
        {
            id: 'dev-switch',
            type: 'device',
            product_data: {
                model_id: 'RWL022',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue dimmer switch',
                product_archetype: 'unknown_archetype',
                certified: true,
                software_version: '2.44.0',
            },
            metadata: { name: 'Switch', archetype: 'unknown_archetype' },
            services: [
                { rid: 'btn-1', rtype: 'button' },
                { rid: 'btn-2', rtype: 'button' },
                { rid: 'btn-3', rtype: 'button' },
                { rid: 'btn-4', rtype: 'button' },
                { rid: 'pow-switch', rtype: 'device_power' },
                { rid: 'zb-switch', rtype: 'zigbee_connectivity' },
            ],
        },
        ...[1, 2, 3, 4].map(n => ({
            id: `btn-${n}`,
            type: 'button',
            owner: { rid: 'dev-switch', rtype: 'device' },
            metadata: { control_id: n },
            button: { last_event: 'short_release' },
        })),
        {
            id: 'pow-switch',
            type: 'device_power',
            owner: { rid: 'dev-switch', rtype: 'device' },
            power_state: { battery_state: 'low', battery_level: 12 },
        },
        {
            id: 'zb-switch',
            type: 'zigbee_connectivity',
            owner: { rid: 'dev-switch', rtype: 'device' },
            status: 'connected',
        },
        {
            id: 'dev-motion',
            type: 'device',
            product_data: {
                model_id: 'SML001',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue motion sensor',
                product_archetype: 'unknown_archetype',
                certified: true,
                software_version: '2.53.6',
            },
            metadata: { name: 'Corridor sensor', archetype: 'unknown_archetype' },
            services: [
                { rid: 'motion-1', rtype: 'motion' },
                { rid: 'temp-1', rtype: 'temperature' },
                { rid: 'll-1', rtype: 'light_level' },
                { rid: 'pow-motion', rtype: 'device_power' },
            ],
        },
        {
            id: 'motion-1',
            type: 'motion',
            owner: { rid: 'dev-motion', rtype: 'device' },
            enabled: true,
            motion: {
                motion: false,
                motion_valid: true,
                motion_report: { changed: '2026-11-13T10:00:00.000Z', motion: false },
            },
        },
        {
            id: 'temp-1',
            type: 'temperature',
            owner: { rid: 'dev-motion', rtype: 'device' },
            enabled: true,
            temperature: {
                temperature: 21.37,
                temperature_valid: true,
                temperature_report: { changed: '2026-11-13T10:00:00.000Z', temperature: 21.37 },
            },
        },
        {
            id: 'll-1',
            type: 'light_level',
            owner: { rid: 'dev-motion', rtype: 'device' },
            enabled: true,
            light: {
                light_level: 20001,
                light_level_valid: true,
                light_level_report: { changed: '2026-11-13T10:00:00.000Z', light_level: 20001 },
            },
        },
        {
            id: 'pow-motion',
            type: 'device_power',
            owner: { rid: 'dev-motion', rtype: 'device' },
            power_state: { battery_state: 'normal', battery_level: 87 },
        },
        {
            id: 'dev-door',
            type: 'device',
            product_data: {
                model_id: 'SOC001',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue secure contact sensor',
                product_archetype: 'unknown_archetype',
                certified: true,
                software_version: '2.67.9',
            },
            metadata: { name: 'Door', archetype: 'unknown_archetype' },
            services: [
                { rid: 'contact-1', rtype: 'contact' },
                { rid: 'tamper-1', rtype: 'tamper' },
            ],
        },
        {
            id: 'contact-1',
            type: 'contact',
            owner: { rid: 'dev-door', rtype: 'device' },
            enabled: true,
            contact_report: { changed: '2026-11-13T10:00:00.000Z', state: 'no_contact' },
        },
        {
            id: 'tamper-1',
            type: 'tamper',
            owner: { rid: 'dev-door', rtype: 'device' },
            tamper_reports: [{ changed: '2026-11-13T10:00:00.000Z', source: 'battery_door', state: 'not_tampered' }],
        },
        {
            id: 'dev-dial',
            type: 'device',
            product_data: {
                model_id: 'RDM002',
                manufacturer_name: 'Signify Netherlands B.V.',
                product_name: 'Hue tap dial switch',
                product_archetype: 'unknown_archetype',
                certified: true,
                software_version: '2.59.25',
            },
            metadata: { name: 'Dial', archetype: 'unknown_archetype' },
            services: [
                { rid: 'dial-btn', rtype: 'button' },
                { rid: 'rotary-1', rtype: 'relative_rotary' },
            ],
        },
        {
            id: 'dial-btn',
            type: 'button',
            owner: { rid: 'dev-dial', rtype: 'device' },
            metadata: { control_id: 1 },
            button: {},
        },
        {
            id: 'rotary-1',
            type: 'relative_rotary',
            owner: { rid: 'dev-dial', rtype: 'device' },
            relative_rotary: {},
        },
        {
            id: 'room-living',
            type: 'room',
            metadata: { name: 'Living room', archetype: 'living_room' },
            children: [
                { rid: 'dev-desk', rtype: 'device' },
                { rid: 'dev-hall', rtype: 'device' },
            ],
            services: [{ rid: 'gl-living', rtype: 'grouped_light' }],
        },
        {
            id: 'gl-living',
            type: 'grouped_light',
            owner: { rid: 'room-living', rtype: 'room' },
            on: { on: true },
            dimming: { brightness: 74.9 },
        },
        {
            id: 'zone-work',
            type: 'zone',
            metadata: { name: 'Work', archetype: 'computer' },
            children: [{ rid: 'light-desk', rtype: 'light' }],
            services: [{ rid: 'gl-work', rtype: 'grouped_light' }],
        },
        {
            id: 'gl-work',
            type: 'grouped_light',
            owner: { rid: 'zone-work', rtype: 'zone' },
            on: { on: true },
            dimming: { brightness: 49.8 },
        },
        {
            id: 'home',
            type: 'bridge_home',
            children: [{ rid: 'room-living', rtype: 'room' }],
            services: [{ rid: 'gl-home', rtype: 'grouped_light' }],
        },
        {
            id: 'gl-home',
            type: 'grouped_light',
            owner: { rid: 'home', rtype: 'bridge_home' },
            on: { on: true },
        },
        {
            id: 'scene-bright',
            type: 'scene',
            metadata: { name: 'Bright' },
            group: { rid: 'room-living', rtype: 'room' },
            status: { active: 'static' },
        },
        {
            id: 'scene-relax',
            type: 'scene',
            metadata: { name: 'Relax' },
            group: { rid: 'room-living', rtype: 'room' },
            status: { active: 'inactive' },
        },
        {
            id: 'smart-1',
            type: 'smart_scene',
            metadata: { name: 'Natural light' },
            group: { rid: 'room-living', rtype: 'room' },
            state: 'inactive',
        },
        {
            id: 'ent-1',
            type: 'entertainment_configuration',
            metadata: { name: 'TV area' },
            status: 'inactive',
        },
        {
            id: 'behavior-1',
            type: 'behavior_instance',
            metadata: { name: 'Wake up' },
            enabled: true,
        },
        {
            id: 'bridge-1',
            type: 'bridge',
            owner: { rid: 'dev-bridge', rtype: 'device' },
            bridge_id: '001788fffe000000',
        },
    ];
    return structuredClone(resources);
}
