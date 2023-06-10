// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            bridge: string;
            port: number;
            user: string;
            polling: boolean;
            pollingInterval: number;
            ignoreGroups: boolean;
            ignoreOsram: boolean;
            ignoreScenes: boolean;
            useLegacyStructure: boolean;
            nativeTurnOffBehaviour: boolean;
            ssl: boolean;
            syncSoftwareSensors: boolean;
            turnOnWithOthers: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
