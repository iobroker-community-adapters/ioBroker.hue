// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** IP address or hostname of the bridge */
            bridge: string;
            /** Application key created via the link button */
            user: string;
            /** Do not create rooms, zones and the "all" group */
            ignoreGroups: boolean;
            /** Do not create scenes and smart scenes */
            ignoreScenes: boolean;
            /** Turn lights on when color, color temperature or effect is changed */
            turnOnWithOthers: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
