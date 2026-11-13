import { expect } from 'chai';
import {
    clampToGamut,
    formatHexColor,
    kelvinToMirek,
    lightLevelToLux,
    mirekToKelvin,
    parseHexColor,
    parseXy,
    rgbToXy,
    xyToRgb,
} from '../../src/lib/color';
import { CommandQueue, deepMerge, type ResourceCommand } from '../../src/lib/hue/commandQueue';
import { parseServerSentEvents } from '../../src/lib/hue/eventStream';
import { HueApiError } from '../../src/lib/hue/client';

const GAMUT_C = { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } };

describe('color', () => {
    it('converts rgb to xy', () => {
        expect(rgbToXy({ r: 255, g: 255, b: 255 })).to.deep.equal({ x: 0.3227, y: 0.329 });
        expect(rgbToXy({ r: 255, g: 0, b: 0 })).to.deep.equal({ x: 0.7006, y: 0.2993 });
        expect(rgbToXy({ r: 0, g: 0, b: 0 })).to.equal(undefined);
    });

    it('converts xy back to a normalized rgb color', () => {
        for (const hex of ['#FF0000', '#0000FF', '#FFFFFF', '#FF8000']) {
            const rgb = xyToRgb(rgbToXy(parseHexColor(hex)!)!);
            const original = parseHexColor(hex)!;
            expect(Math.abs(rgb.r - original.r)).to.be.at.most(3, hex);
            expect(Math.abs(rgb.g - original.g)).to.be.at.most(3, hex);
            expect(Math.abs(rgb.b - original.b)).to.be.at.most(3, hex);
        }
    });

    it('clamps color points into the gamut', () => {
        const inside = { x: 0.4, y: 0.4 };
        expect(clampToGamut(inside, GAMUT_C)).to.equal(inside);

        // pure green of the CIE diagram is far outside gamut C
        const clamped = clampToGamut({ x: 0.1, y: 0.85 }, GAMUT_C);
        expect(clamped).to.deep.equal({ x: 0.17, y: 0.7 });

        // without a gamut every valid point is accepted
        expect(clampToGamut({ x: 0.1, y: 0.85 })).to.deep.equal({ x: 0.1, y: 0.85 });
    });

    it('parses and formats values', () => {
        expect(parseHexColor('#ff8000')).to.deep.equal({ r: 255, g: 128, b: 0 });
        expect(parseHexColor('ff8000')).to.deep.equal({ r: 255, g: 128, b: 0 });
        expect(parseHexColor('#fff')).to.equal(undefined);
        expect(formatHexColor({ r: 255, g: 128, b: 0 })).to.equal('#FF8000');

        expect(parseXy('0.3,0.4')).to.deep.equal({ x: 0.3, y: 0.4 });
        expect(parseXy([0.3, 0.4])).to.deep.equal({ x: 0.3, y: 0.4 });
        expect(parseXy({ x: 0.3, y: 0.4 })).to.deep.equal({ x: 0.3, y: 0.4 });
        expect(parseXy('0.3')).to.equal(undefined);
        expect(parseXy('a,b')).to.equal(undefined);

        expect(mirekToKelvin(250)).to.equal(4000);
        expect(kelvinToMirek(2700)).to.equal(370);
        expect(lightLevelToLux(1)).to.equal(1);
        expect(lightLevelToLux(30001)).to.equal(1000);
    });
});

describe('event stream parser', () => {
    it('parses complete frames and keeps the incomplete rest', () => {
        const text = ': hi\n\nid: 1:0\ndata: [{"type":"update"}]\n\nid: 2:0\ndata: [{"ty';
        const { events, rest } = parseServerSentEvents(text);

        expect(events).to.deep.equal([{ id: '1:0', data: '[{"type":"update"}]' }]);
        expect(rest).to.equal('id: 2:0\ndata: [{"ty');

        const next = parseServerSentEvents(`${rest}pe":"add"}]\r\n\r\n`);
        expect(next.events).to.deep.equal([{ id: '2:0', data: '[{"type":"add"}]' }]);
        expect(next.rest).to.equal('');
    });

    it('joins multi-line data', () => {
        const { events } = parseServerSentEvents('data: [\ndata: 1]\n\n');
        expect(events).to.deep.equal([{ data: '[\n1]' }]);
    });
});

describe('command queue', () => {
    it('deep merges bodies', () => {
        expect(
            deepMerge({ on: { on: true }, dimming: { brightness: 10 } }, { dimming: { brightness: 20 } }),
        ).to.deep.equal({ on: { on: true }, dimming: { brightness: 20 } });
    });

    it('merges waiting commands for the same resource', async () => {
        const sent: ResourceCommand[] = [];
        let release!: () => void;
        const firstSent = new Promise<void>(resolve => (release = resolve));

        const queue = new CommandQueue(
            async cmd => {
                sent.push(cmd);
                if (sent.length === 1) {
                    await firstSent;
                }
            },
            () => Promise.resolve(),
        );

        const p1 = queue.enqueue({ rtype: 'light', rid: 'a', body: { on: { on: true } } });
        // these wait while the first command is in flight and are merged into one request
        const p2 = queue.enqueue({ rtype: 'light', rid: 'a', body: { dimming: { brightness: 10 } } });
        const p3 = queue.enqueue({ rtype: 'light', rid: 'a', body: { dimming: { brightness: 20 } } });
        const p4 = queue.enqueue({ rtype: 'light', rid: 'b', body: { on: { on: false } } });
        release();
        await Promise.all([p1, p2, p3, p4]);

        expect(sent).to.deep.equal([
            { rtype: 'light', rid: 'a', body: { on: { on: true } } },
            { rtype: 'light', rid: 'a', body: { dimming: { brightness: 20 } } },
            { rtype: 'light', rid: 'b', body: { on: { on: false } } },
        ]);
    });

    it('retries if the bridge is overloaded and rejects on other errors', async () => {
        let calls = 0;
        const queue = new CommandQueue(
            () => {
                calls++;
                return calls < 3 ? Promise.reject(new HueApiError('busy', 429)) : Promise.resolve();
            },
            () => Promise.resolve(),
        );
        await queue.enqueue({ rtype: 'light', rid: 'a', body: {} });
        expect(calls).to.equal(3);

        const failing = new CommandQueue(
            () => Promise.reject(new HueApiError('invalid', 400)),
            () => Promise.resolve(),
        );
        let error: unknown;
        try {
            await failing.enqueue({ rtype: 'light', rid: 'a', body: {} });
        } catch (e) {
            error = e;
        }
        expect((error as HueApiError).status).to.equal(400);
    });
});
