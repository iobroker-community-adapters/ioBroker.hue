import net from 'node:net';
import { Bonjour } from 'bonjour-service';

/** Cloud based discovery endpoint of Signify */
const DISCOVERY_URL = 'https://discovery.meethue.com';

/**
 * Discover bridges in the local network via mDNS
 *
 * @param timeout time to wait for answers in ms
 */
export function discoverViaMdns(timeout: number): Promise<string[]> {
    return new Promise(resolve => {
        const found = new Set<string>();
        const bonjour = new Bonjour();
        const browser = bonjour.find({ type: 'hue' }, service => {
            const addresses = service.addresses?.length ? service.addresses : [service.referer?.address];
            for (const address of addresses) {
                if (address && net.isIPv4(address)) {
                    found.add(address);
                }
            }
        });

        setTimeout(() => {
            browser.stop();
            bonjour.destroy();
            resolve([...found]);
        }, timeout);
    });
}

/**
 * Discover bridges via the Signify cloud service (bridges report their local IP there)
 *
 * @param timeout request timeout in ms
 */
export async function discoverViaCloud(timeout: number): Promise<string[]> {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(timeout) });

    if (!res.ok) {
        throw new Error(`Discovery service answered with HTTP ${res.status}`);
    }

    const data = (await res.json()) as { internalipaddress?: string }[];
    return data.map(entry => entry.internalipaddress).filter((ip): ip is string => !!ip);
}
