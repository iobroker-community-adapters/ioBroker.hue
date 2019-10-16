/**
 *
 *      ioBroker Philips Hue Bridge Adapter
 *
 *      Copyright (c) 2017-2019 Bluefox <dogafox@gmail.com>
 *      Copyright (c) 2014-2016 hobbyquaker *
 *      Apache License
 *
 */
/* jshint -W097 */
/* jshint strict: false */
/* jshint esversion: 6  */
/* jslint node: true */
'use strict';

const hue = require('node-hue-api');
const v3 = hue.v3;
const utils = require('@iobroker/adapter-core');
const hueHelper = require('./lib/hueHelper');
const Bottleneck = require('bottleneck');
const md5 = require('md5');

let adapter;
let pollingInterval;
let reconnectTimeout;

const supportedSensors = ['ZLLSwitch',
    'ZGPSwitch',
    'Daylight',
    'ZLLTemperature',
    'ZLLPresence',
    'ZLLLightLevel'];

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'hue',
        stateChange: async (id, state) => {
            if (!id || !state || state.ack) {
                return;
            }

            adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
            const tmp = id.split('.');
            const dp = tmp.pop();

            if (dp.startsWith('scene_')) {
                try {
                    // its a scene -> get scene id to start it
                    const obj = await adapter.getForeignObjectAsync(id);

                    submitHueCmd('activateScene', {
                        id: obj.native.id,
                        prio: 1
                    }, (err) => {
                        if (!err) {
                            adapter.log.info(`Started scene: ${obj.common.name}`);
                        } else {
                            adapter.log.warn(`Could not start scene: ${err}`);
                        } // endElse
                    });
                } catch (e) {
                    adapter.log.warn(`Could not start scene: ${e}`);
                } // endCatch
                return;
            } // endIf

            // check if its a sensor
            const channelId = id.substring(0, id.lastIndexOf('.'));
            const channelObj = await adapter.getForeignObjectAsync(channelId);

            if (channelObj && channelObj.common && supportedSensors.includes(channelObj.common.role)) {
                // its a sensor - we need node-hue-api v3 for this
                // const sensor = api.sensors.get(channelObj.native.id);
                adapter.log.warn(`Changed ${dp} of sensor ${channelObj.native.id} to ${state.val} - currently not supported`);
                return;
            } // endIf


            id = tmp.slice(2).join('.');

            const fullIdBase = `${tmp.join('.')}.`;
            let ls = {};
            // if .on changed instead change .bri to 254 or 0
            let bri = 0;
            if (dp === 'on' && !adapter.config.nativeTurnOffBehaviour) {
                bri = state.val ? 254 : 0;
                adapter.setState([id, 'bri'].join('.'), {val: bri, ack: false});
                return;
            }
            // if .level changed instead change .bri to level.val*254
            if (dp === 'level') {
                bri = Math.max(Math.min(Math.round(state.val * 2.54), 254), 0);
                adapter.setState([id, 'bri'].join('.'), {val: bri, ack: false});
                return;
            }
            // get lamp states
            adapter.getStates(`${id}.*`, (err, idStates) => {
                if (err) {
                    adapter.log.error(err);
                    return;
                }
                // gather states that need to be changed
                ls = {};
                const alls = {};
                let lampOn = false;
                let commandSupported = false;

                function handleParam(idState, prefill) {
                    if (idStates[idState] === undefined) return;
                    if (prefill && !idStates[idState].ack) return;

                    const idtmp = idState.split('.');
                    const iddp = idtmp.pop();
                    switch (iddp) {
                        case 'on':
                            alls['bri'] = idStates[idState].val ? 254 : 0;
                            ls['bri'] = idStates[idState].val ? 254 : 0;
                            if (idStates[idState].ack && ls['bri'] > 0) lampOn = true;
                            break;
                        case 'bri':
                            alls[iddp] = idStates[idState].val;
                            ls[iddp] = idStates[idState].val;
                            if (idStates[idState].ack && idStates[idState].val > 0) lampOn = true;
                            break;
                        case 'alert':
                            alls[iddp] = idStates[idState].val;
                            if (dp === 'alert') ls[iddp] = idStates[idState].val;
                            break;
                        case 'effect':
                            alls[iddp] = idStates[idState].val;
                            if (dp === 'effect') ls[iddp] = idStates[idState].val;
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
                            alls[iddp] = idStates[idState].val;
                            break;
                    }
                    idStates[idState].handled = true;
                }

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
                // Handle commands at the end because they overwrite also anything
                if (commandSupported && dp === 'command') {
                    try {
                        const commands = JSON.parse(state.val);
                        for (const command in commands) {
                            if (!commands.hasOwnProperty(command)) {
                                continue;
                            }
                            if (command === 'on') {
                                //convert on to bri
                                if (commands[command] && !commands.hasOwnProperty('bri')) {
                                    ls.bri = 254;
                                } else {
                                    ls.bri = 0;
                                }
                            } else if (command === 'level') {
                                //convert level to bri
                                if (!commands.hasOwnProperty('bri')) {
                                    ls.bri = Math.min(254, Math.max(0, Math.round(parseInt(commands[command]) * 2.54)));
                                } else {
                                    ls.bri = 254;
                                }
                            } else {
                                ls[command] = commands[command];
                            }
                        }
                    } catch (e) {
                        adapter.log.error(e);
                        return;
                    }
                }

                // get lightState
                adapter.getObject(id, (err, obj) => {
                    if (err || !obj) {
                        if (!err) err = new Error(`obj "${id}" in callback getObject is null or undefined`);
                        adapter.log.error(err);
                        return;
                    }

                    // apply rgb to xy with modelId
                    if ('r' in ls || 'g' in ls || 'b' in ls) {
                        if (!('r' in ls)) {
                            ls.r = 0;
                        }
                        if (!('g' in ls)) {
                            ls.g = 0;
                        }
                        if (!('b' in ls)) {
                            ls.b = 0;
                        }
                        const xyb = hueHelper.RgbToXYB(ls.r / 255, ls.g / 255, ls.b / 255, (obj.native.hasOwnProperty('modelid') ? obj.native.modelid.trim() : 'default'));
                        ls.bri = xyb.b;
                        ls.xy = `${xyb.x},${xyb.y}`;
                    }

                    // create lightState from ls and check values
                    let lightState = obj.common.role === 'LightGroup' || obj.common.role === 'Room' ? new v3.lightStates.GroupLightState() : new v3.lightStates.LightState();
                    let finalLS = {};
                    if (ls.bri > 0) {
                        lightState = lightState.on().bri(Math.min(254, ls.bri));
                        finalLS.bri = Math.min(254, ls.bri);
                        finalLS.on = true;
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
                                adapter.log.warn(`Invalid xy value: "${ls.xy}"`);
                                ls.xy = '0,0';
                            }
                        }
                        let xy = ls.xy.toString().split(',');
                        xy = {'x': xy[0], 'y': xy[1]};
                        xy = hueHelper.GamutXYforModel(xy.x, xy.y, (obj.native.hasOwnProperty('modelid') ? obj.native.modelid.trim() : 'default'));
                        finalLS.xy = `${xy.x},${xy.y}`;
                        lightState = lightState.xy(xy.x, xy.y);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                        const rgb = hueHelper.XYBtoRGB(xy.x, xy.y, (finalLS.bri / 254));
                        finalLS.r = Math.round(rgb.Red * 254);
                        finalLS.g = Math.round(rgb.Green * 254);
                        finalLS.b = Math.round(rgb.Blue * 254);
                    }
                    if ('ct' in ls) {
                        finalLS.ct = Math.max(2200, Math.min(6500, ls.ct));
                        // convert kelvin to mired
                        finalLS.ct = Math.round(1e6 / finalLS.ct);

                        lightState = lightState.ct(finalLS.ct);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                    }
                    if ('hue' in ls) {
                        finalLS.hue = Math.min(ls.hue, 360);
                        if (finalLS.hue < 0) {
                            finalLS.hue = 360;
                        }
                        // Convert 360° into 0-65535 value
                        finalLS.hue = Math.round(finalLS.hue / 360 * 65535);

                        if (finalLS.hue > 65535) { // may be round error
                            finalLS.hue = 65535;
                        }

                        lightState = lightState.hue(finalLS.hue);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                    }
                    if ('sat' in ls) {
                        finalLS.sat = Math.max(0, Math.min(254, ls.sat));
                        lightState = lightState.sat(finalLS.sat);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
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
                        if (!lampOn && (finalLS.effect !== 'none' && !('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                    }

                    // only available in command state
                    if ('transitiontime' in ls) {
                        const transitiontime = parseInt(ls.transitiontime);
                        if (!isNaN(transitiontime)) {
                            finalLS.transitiontime = transitiontime;
                            lightState = lightState.transitiontime(transitiontime);
                        }
                    }
                    if ('sat_inc' in ls && !('sat' in finalLS) && 'sat' in alls) {
                        finalLS.sat = (((ls.sat_inc + alls.sat) % 255) + 255) % 255;
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
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
                        alls.hue = alls.hue / 360 * 65535;

                        if (alls.hue > 65535) { // may be round error
                            alls.hue = 65535;
                        }

                        finalLS.hue = (((ls.hue_inc + alls.hue) % 65536) + 65536) % 65536;

                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                        lightState = lightState.hue(finalLS.hue);
                    }
                    if ('ct_inc' in ls && !('ct' in finalLS) && 'ct' in alls) {
                        alls.ct = (500 - 153) - ((alls.ct - 2200) / (6500 - 2200)) * (500 - 153) + 153;

                        finalLS.ct = (((((alls.ct - 153) + ls.ct_inc) % 348) + 348) % 348) + 153;
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
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
                                adapter.setState([id, 'bri'].join('.'), {val: 0, ack: false});
                                return;
                            }
                        } else {
                            finalLS.on = true;
                            lightState = lightState.on();
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

                    // if dp is on and we use native turn off behaviour only set the lightState
                    if (dp === 'on' && adapter.config.nativeTurnOffBehaviour) {
                        // todo: this is somehow dirty but the code above is messy -> integrate above in a more clever way later
                        lightState = obj.common.role === 'LightGroup' || obj.common.role === 'Room' ? new v3.lightStates.GroupLightState() : new v3.lightStates.LightState();
                        if (state.val) {
                            lightState.on();
                        } else {
                            lightState.off();
                        } // endElse
                    } else if (dp === 'command' && adapter.config.nativeTurnOffBehaviour && Object.keys(JSON.parse(state.val)).length === 1 && JSON.parse(state.val).on !== undefined) {
                        lightState = obj.common.role === 'LightGroup' || obj.common.role === 'Room' ? new v3.lightStates.GroupLightState() : new v3.lightStates.LightState();
                        if (JSON.parse(state.val).on) {
                            lightState.on();
                        } else {
                            lightState.off();
                        } // endElse
                    } // endElseIf

                    if (obj.common.role === 'LightGroup' || obj.common.role === 'Room') {
                        if (!adapter.config.ignoreGroups) {
                            // log final changes / states
                            adapter.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);

                            submitHueCmd('groups.setGroupState', {
                                id: groupIds[id],
                                data: lightState,
                                prio: 1
                            }, (err, result) => {
                                setTimeout(updateGroupState, 150, {
                                    id: groupIds[id],
                                    name: obj.common.name
                                }, 3, (err, result) => {
                                    adapter.log.debug(`updated group state(${groupIds[id]}) after change`);
                                });
                            });
                        }
                    } else if (obj.common.role === 'switch') {
                        if (finalLS.hasOwnProperty('on')) {
                            finalLS = {on: finalLS.on};
                            // log final changes / states
                            adapter.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);

                            lightState = new v3.lightStates.LightState();
                            lightState.on(finalLS.on);

                            submitHueCmd('lights.setLightState', {
                                id: channelIds[id],
                                data: lightState,
                                prio: 1
                            }, (err, result) => {
                                setTimeout(updateLightState, 150, {
                                    id: channelIds[id],
                                    name: obj.common.name
                                }, 3, (err, result) => {
                                    adapter.log.debug(`updated lighstate(${channelIds[id]}) after change`);
                                });
                            });
                        } else {
                            adapter.log.warn('invalid switch operation');
                        }
                    } else {
                        // log final changes / states
                        adapter.log.debug(`final lightState for ${obj.common.name}:${JSON.stringify(finalLS)}`);

                        submitHueCmd('lights.setLightState', {
                            id: channelIds[id],
                            data: lightState,
                            prio: 1
                        }, (err, result) => {
                            setTimeout(updateLightState, 150, {
                                id: channelIds[id],
                                name: obj.common.name
                            }, 3, (err, result) => {
                                adapter.log.debug(`updated lighstate(${channelIds[id]}) after change`);
                            });
                        });
                    }
                });
            });
        },
        message: obj => {
            let wait = false;
            if (obj) {
                switch (obj.command) {
                    case 'browse':
                        browse(obj.message, res => obj.callback && adapter.sendTo(obj.from, obj.command, JSON.stringify(res), obj.callback));
                        wait = true;
                        break;
                    case 'createUser':
                        createUser(obj.message, res => obj.callback && adapter.sendTo(obj.from, obj.command, JSON.stringify(res), obj.callback));
                        wait = true;
                        break;
                    default:
                        adapter.log.warn(`Unknown command: ${obj.command}`);
                        break;
                }
            }
            if (!wait && obj.callback) {
                adapter.sendTo(obj.from, obj.command, obj.message, obj.callback);
            }
            return true;
        },
        ready: () => {
            main();
        },
        unload: callback => {
            try {
                if (pollingInterval) {
                    clearInterval(pollingInterval);
                    pollingInterval = null;
                }

                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }
                adapter.log.info('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        }
    });

    adapter = new utils.Adapter(options);

    return adapter;
}

function browse(timeout, callback) {
    timeout = parseInt(timeout);
    if (isNaN(timeout)) {
        timeout = 5000;
    }
    v3.discovery.upnpSearch(timeout).then(callback);
}

async function createUser(ip, callback) {
    const newUserName = null;
    const userDescription = 'ioBroker.hue';
    try {
        const api = await v3.api.create(adapter.config.bridge);
        const newUser = await api.users.createUser(ip, newUserName, userDescription);
        adapter.log.info(`created new User: ${newUser}`);
        callback({error: 0, message: newUser});
    } catch (e) {
        // 101 is bridge button not pressed
        if (e.getHueErrorType() !== 101) adapter.log.error(e);
        callback({error: e.getHueErrorType(), message: JSON.stringify(e)});
    }
} // endCreateUser

let api;

let groupQueue;
let lightQueue;

const channelIds = {};
const groupIds = {};
const pollLights = [];
const pollSensors = [];
const pollGroups = [];

function submitHueCmd(cmd, args, callback) {
    // select the bottleneck queue to be used
    let queue = lightQueue;
    if (cmd === 'getGroup' || cmd === 'setGroupLightState') {
        queue = groupQueue;
    }

    // construct a unique id based on the command name
    // and serialized arguments
    const id = `${cmd}:${args.id}:${md5(JSON.stringify(args))}`;

    // skip any job submit if a job with the same id already exists in the
    // queue
    if (queue.jobStatus(id) !== null) {
        adapter.log.debug(`job ${id} already in queue, skipping..`);
        return;
    }


    // submit the job to the bottleneck
    // queue
    queue.submit({priority: args.prio, expiration: 5000, id: id}, async (arg, cb) => {
        if (cmd === 'getFullState') {
            try {
                const res = await api.configuration.getAll();
                cb(null, res);
            } catch (e) {
                cb(e);
            } // endCatch
        } else if (arg.data !== undefined) {
            try {
                if (cmd.split('.').length === 2) {
                    const cmdArr = cmd.split('.');
                    const res = await api[cmdArr[0]][cmdArr[1]](arg.id, arg.data);
                    cb(null, res);
                } else {
                    const res = await api[cmd](arg.id, arg.data);
                    cb(null, res);
                } // endElse
            } catch (e) {
                cb(e);
            } // endCatch
        } else {
            try {
                if (cmd.split('.').length === 2) {
                    const cmdArr = cmd.split('.');
                    const res = await api[cmdArr[0]][cmdArr[1]](arg.id);
                    cb(null, res);
                } else {
                    const res = await api[cmd](arg.id);
                    cb(null, res);
                } // endElse
            } catch (e) {
                cb(e);
            } // endCatch
        } // endElse
    }, args, (err, result) => {
        if (err === null && result !== false) {
            adapter.log.debug(`${id} result: ${JSON.stringify(result)}`);
            callback(err, result);
        }
    });
}

function updateGroupState(group, prio, callback) {
    adapter.log.debug(`polling group ${group.name} (${group.id}) with prio ${prio}`);

    submitHueCmd('groups.get', {id: group.id, prio: prio}, (err, result) => {
        const values = [];
        const states = {};
        result = result['_rawData'];

        for (const stateA in result.action) {
            if (!result.action.hasOwnProperty(stateA)) {
                continue;
            }
            states[stateA] = result.action[stateA];
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
            const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
            states.r = Math.round(rgb.Red * 254);
            states.g = Math.round(rgb.Green * 254);
            states.b = Math.round(rgb.Blue * 254);
        }
        if (states.bri !== undefined) {
            states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
        }

        if (states.hue !== undefined) {
            states.hue = Math.round(states.hue / 65535 * 360);
        }
        if (states.ct !== undefined) {
            // convert color temperature from mired to kelvin
            states.ct = Math.round(1e6 / states.ct);
        }

        for (const stateB in states) {
            if (!states.hasOwnProperty(stateB)) {
                continue;
            }
            values.push({id: `${adapter.namespace}.${group.name}.${stateB}`, val: states[stateB]});
        }

        syncStates(values, true, callback);
    });
}

function updateLightState(light, prio, callback) {
    adapter.log.debug(`polling light ${light.name} (${light.id}) with prio ${prio}`);

    submitHueCmd('lights.getLightById', {id: light.id, prio: prio}, (err, result) => {
        const values = [];
        const states = {};

        // adapter.log.warn('updated ' + JSON.stringify(result))

        if (result.swupdate && result.swupdate.state) {
            values.push({id: `${adapter.namespace}.${light.name}.updateable`, val: result.swupdate.state});
        } // endIf

        for (const stateA in result.state) {
            if (!result.state.hasOwnProperty(stateA)) {
                continue;
            }
            states[stateA] = result.state[stateA];
        }

        if (!adapter.config.ignoreOsram) {
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
            const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
            states.r = Math.round(rgb.Red * 254);
            states.g = Math.round(rgb.Green * 254);
            states.b = Math.round(rgb.Blue * 254);
        }
        if (states.bri !== undefined) {
            states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
        }

        if (states.hue !== undefined) {
            states.hue = Math.round(states.hue / 65535 * 360);
        }
        if (states.ct !== undefined) {
            // convert color temperature from mired to kelvin
            states.ct = Math.round(1e6 / states.ct);
        }
        for (const stateB in states) {
            if (!states.hasOwnProperty(stateB)) {
                continue;
            }
            values.push({id: `${adapter.namespace}.${light.name}.${stateB}`, val: states[stateB]});
        }

        syncStates(values, true, callback);
    });
}

async function connect(cb) {
    let config;
    try {
        config = await api.configuration.getAll();
    } catch (e) {
        adapter.log.warn(`could not connect to HUE bridge (${adapter.config.bridge}:${adapter.config.port})`);
        adapter.log.error(e);
        reconnectTimeout = setTimeout(connect, 5000, cb);
        return;
    } // endCatch

    if (!config) {
        adapter.log.warn(`could not get configuration from HUE bridge (${adapter.config.bridge}:${adapter.config.port})`);
        reconnectTimeout = setTimeout(connect, 5000, cb);
        return;
    } // endIf

    // even if useLegacyStructure is false, we check if the structure exists to not create chaos
    if (!adapter.config.useLegacyStructure) {
        const legacyObj = await adapter.getObjectAsync(`${adapter.namespace}.${config.config.name.replace(/\s/g, '_')}`);
        if (legacyObj) {
            adapter.config.useLegacyStructure = true;
            adapter.log.info('Use legacy structure, because existing');
        } // endIf
    } // endIf

    const channelNames = [];

    // Create/update lamps
    const lights = config.lights;
    const sensors = config.sensors;
    const objs = [];
    const states = [];

    for (const sid in sensors) {
        if (!sensors.hasOwnProperty(sid)) {
            continue;
        }

        const sensor = sensors[sid];

        if (supportedSensors.includes(sensor.type)) {

            let channelName = adapter.config.useLegacyStructure ? `${config.config.name}.${sensor.name}` : sensor.name;
            if (channelNames.indexOf(channelName) !== -1) {
                const newChannelName = `${channelName} ${sensor.type}`;
                if (channelNames.indexOf(newChannelName) !== -1) {
                    adapter.log.error(`channel "${channelName.replace(/\s/g, '_')}" already exists, could not use "${newChannelName.replace(/\s/g, '_')}" as well, skipping sensor ${sid}`);
                    continue;
                } else {
                    adapter.log.warn(`channel "${channelName.replace(/\s/g, '_')}" already exists, using "${newChannelName.replace(/\s/g, '_')}" for sensor ${sid}`);
                    channelName = newChannelName;
                }
            } else {
                channelNames.push(channelName);
            }

            const sensorName = sensor.name.replace(/\s/g, '');

            pollSensors.push({id: sid, name: channelName.replace(/\s/g, '_'), sname: sensorName});

            const sensorCopy = {...sensor.state, ...sensor.config};
            for (const state in sensorCopy) {
                if (!sensorCopy.hasOwnProperty(state)) {
                    continue;
                }
                const objId = `${channelName}.${state}`;

                const lobj = {
                    _id: `${adapter.namespace}.${objId.replace(/\s/g, '_')}`,
                    type: 'state',
                    common: {
                        name: objId,
                        read: true,
                        write: true
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
                        break;
                    case 'reachable':
                        lobj.common.type = 'boolean';
                        lobj.common.write = false;
                        lobj.common.role = 'indicator.reachable';
                        break;
                    case 'buttonevent':
                        lobj.common.type = 'number';
                        lobj.common.role = 'state';
                        break;
                    case 'lastupdated':
                        lobj.common.type = 'string';
                        lobj.common.role = 'date';
                        break;
                    case 'battery':
                        lobj.common.type = 'number';
                        lobj.common.role = 'config';
                        break;
                    case 'pending':
                        lobj.common.type = 'number';
                        lobj.common.role = 'config';
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
                        lobj.common.max = 17000;
                        break;
                    case 'temperature':
                        lobj.common.type = 'number';
                        lobj.common.role = 'indicator.temperature';
                        value = convertTemperature(value);
                        break;
                    default:
                        adapter.log.info(`skip switch: ${objId}`);
                        break;
                }

                objs.push(lobj);
                states.push({id: lobj._id, val: value});
            }

            objs.push({
                _id: `${adapter.namespace}.${channelName.replace(/\s/g, '_')}`,
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
                    swversion: sensor.swversion,
                }
            });
        }
    }

    adapter.log.info(`created/updated ${pollSensors.length} sensor channels`);

    for (const lid in lights) {
        if (!lights.hasOwnProperty(lid)) {
            continue;
        }
        const light = lights[lid];

        let channelName = adapter.config.useLegacyStructure ? `${config.config.name}.${light.name}` : light.name;
        if (channelNames.indexOf(channelName) !== -1) {
            const newChannelName = `${channelName} ${light.type}`;
            if (channelNames.indexOf(newChannelName) !== -1) {
                adapter.log.error(`channel "${channelName.replace(/\s/g, '_')}" already exists, could not use "${newChannelName.replace(/\s/g, '_')}" as well, skipping light ${lid}`);
                continue;
            } else {
                adapter.log.warn(`channel "${channelName.replace(/\s/g, '_')}" already exists, using "${newChannelName.replace(/\s/g, '_')}" for light ${lid}`);
                channelName = newChannelName;
            }
        } else {
            channelNames.push(channelName);
        }
        channelIds[channelName.replace(/\s/g, '_')] = lid;
        pollLights.push({id: lid, name: channelName.replace(/\s/g, '_')});

        if (light.type === 'Extended color light' || light.type === 'Color light') {
            light.state.r = 0;
            light.state.g = 0;
            light.state.b = 0;
        }

        if (light.type !== 'On/Off plug-in unit') {
            light.state.command = '{}';
            light.state.level = 0;
        }

        // Create swUpdate state for every light
        if (light.swupdate && light.swupdate.state) {
            const objId = `${channelName}.updateable`;

            const lobj = {
                _id: `${adapter.namespace}.${objId.replace(/\s/g, '_')}`,
                type: 'state',
                common: {
                    name: objId,
                    read: true,
                    write: false,
                    type: 'string',
                    role: 'indicator.update'
                },
                native: {
                    id: lid
                }
            };
            objs.push(lobj);
            states.push({id: lobj._id, val: light.swupdate.state});
        } // endIf

        for (const state in light.state) {
            if (!light.state.hasOwnProperty(state)) {
                continue;
            }
            let value = light.state[state];
            const objId = `${channelName}.${state}`;

            const lobj = {
                _id: `${adapter.namespace}.${objId.replace(/\s/g, '_')}`,
                type: 'state',
                common: {
                    name: objId,
                    read: true,
                    write: true
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
                    value = Math.round(value / 65535 * 360);
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
                case 'ct':
                    lobj.common.type = 'number';
                    lobj.common.role = 'level.color.temperature';
                    lobj.common.unit = '°K';
                    lobj.common.min = 2200; // 500
                    lobj.common.max = 6500; // 153
                    value = Math.round(1e6 / value);
                    break;
                case 'alert':
                    lobj.common.type = 'string';
                    lobj.common.role = 'switch';
                    break;
                case 'effect':
                    lobj.common.type = 'boolean';
                    lobj.common.role = 'switch';
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
                    lobj.common.type = 'number';
                    lobj.common.role = 'config';
                    break;
                case 'mode':
                    lobj.common.type = 'string';
                    lobj.common.role = 'text';
                    break;

                default:
                    adapter.log.info(`skip light: ${objId}`);
                    break;
            }

            objs.push(lobj);
            states.push({id: lobj._id, val: value});
        }

        let role = 'light.color';
        if (light.type === 'Dimmable light' || light.type === 'Dimmable plug-in unit') {
            role = 'light.dimmer';
        } else if (light.type === 'On/Off plug-in unit') {
            role = 'switch';
        }

        objs.push({
            _id: `${adapter.namespace}.${channelName.replace(/\s/g, '_')}`,
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
    adapter.log.info(`created/updated ${pollLights.length} light channels`);

    // Create/update groups
    if (!adapter.config.ignoreGroups) {
        const groups = config.groups;
        groups[0] = {
            name: 'All',   //"Lightset 0"
            type: 'LightGroup',
            id: 0,
            action: {
                alert: 'select',
                bri: 0,
                colormode: '',
                ct: 0,
                effect: 'none',
                hue: 0,
                on: false,
                sat: 0,
                xy: '0,0'
            }
        };
        for (const gid in groups) {
            if (!groups.hasOwnProperty(gid)) {
                continue;
            }
            const group = groups[gid];

            let groupName = adapter.config.useLegacyStructure ? `${config.config.name}.${group.name}` : group.name;
            if (channelNames.indexOf(groupName) !== -1) {
                const newGroupName = `${groupName} ${group.type}`;
                if (channelNames.indexOf(newGroupName) !== -1) {
                    adapter.log.error(`channel "${groupName.replace(/\s/g, '_')}" already exists, could not use "${newGroupName.replace(/\s/g, '_')}" as well, skipping group ${gid}`);
                    continue;
                } else {
                    adapter.log.warn(`channel "${groupName.replace(/\s/g, '_')}" already exists, using "${newGroupName.replace(/\s/g, '_')}" for group ${gid}`);
                    groupName = newGroupName;
                }
            } else {
                channelNames.push(groupName);
            }
            groupIds[groupName.replace(/\s/g, '_')] = gid;
            pollGroups.push({id: gid, name: groupName.replace(/\s/g, '_')});

            group.action.r = 0;
            group.action.g = 0;
            group.action.b = 0;
            group.action.command = '{}';
            group.action.level = 0;

            for (const action in group.action) {
                if (!group.action.hasOwnProperty(action)) {
                    continue;
                }

                const gobjId = `${groupName}.${action}`;

                const gobj = {
                    _id: `${adapter.namespace}.${gobjId.replace(/\s/g, '_')}`,
                    type: 'state',
                    common: {
                        name: gobjId,
                        read: true,
                        write: true
                    },
                    native: {
                        id: gid
                    }
                };
                if (typeof group.action[action] === 'object') {
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
                        gobj.common.min = 2200; // 500
                        gobj.common.max = 6500; // 153
                        break;
                    case 'alert':
                        gobj.common.type = 'string';
                        gobj.common.role = 'switch';
                        break;
                    case 'effect':
                        gobj.common.type = 'boolean';
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
                    default:
                        adapter.log.info(`skip group: ${gobjId}`);
                        continue;
                }
                objs.push(gobj);
                states.push({id: gobj._id, val: group.action[action]});
            } // endFor

            // Create anyOn state
            if (gid !== '0') {
                objs.push({
                    _id: `${adapter.namespace}.${groupName.replace(/\s/g, '_')}.anyOn`,
                    type: 'state',
                    common: {
                        name: `${groupName}.anyOn`,
                        role: 'indicator.switch',
                        read: true,
                        write: false
                    },
                    native: {}
                });

                states.push({
                    id: `${adapter.namespace}.${groupName.replace(/\s/g, '_')}.anyOn`,
                    val: group.state['any_on']
                });
            } // endIf
            objs.push({
                _id: `${adapter.namespace}.${groupName.replace(/\s/g, '_')}`,
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
        } // endFor
        adapter.log.info(`created/updated ${pollGroups.length} groups channels`);

    }

    // create scene states
    if (!adapter.config.ignoreScenes) {
        try {
            const scenes = config.scenes;

            // Create obj to get groupname in constant time
            const groupNames = {};
            for (const key in groupIds) {
                groupNames[groupIds[key]] = key;
            } // endFor

            let sceneChannelCreated = false;

            let sceneCounter = 0;
            const sceneNamespace = adapter.config.useLegacyStructure ? `${adapter.namespace}.${config.config.name.replace(/\s/g, '_')}` : `${adapter.namespace}`;
            for (const sceneId in scenes) {
                const scene = scenes[sceneId];
                if (scene.type === 'GroupScene') {
                    if (adapter.config.ignoreGroups) continue;
                    adapter.log.debug(`Create ${scene.name} in ${groupNames[scene.group]}`);
                    objs.push({
                        _id: `${adapter.namespace}.${groupNames[scene.group]}.scene_${scene.name.replace(/\s/g, '_').toLowerCase()}`,
                        type: 'state',
                        common: {
                            name: `Scene ${scene.name}`,
                            role: 'button'
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
                    } // endIf

                    adapter.log.debug(`Create ${scene.name}`);
                    objs.push({
                        _id: `${sceneNamespace}.lightScenes.scene_${scene.name.replace(/\s/g, '_').toLowerCase()}`,
                        type: 'state',
                        common: {
                            name: `Scene ${scene.name}`,
                            role: 'button'
                        },
                        native: {
                            id: sceneId
                        }
                    });
                    sceneCounter++;
                } // edElse
            } // endFor
            adapter.log.info(`created/updated ${sceneCounter} scenes`);
        } catch (e) {
            adapter.log.warn(`Error syncing scenes: ${e}`);
        } // endCatch

    } // endIf

    // Create/update device
    adapter.log.info('creating/updating bridge device');
    objs.push({
        _id: adapter.config.useLegacyStructure ? `${adapter.namespace}.${config.config.name.replace(/\s/g, '_')}` : adapter.namespace,
        type: 'device',
        common: {
            name: config.config.name
        },
        native: config.config
    });

    syncObjects(objs, () => syncStates(states, false, cb));
} // endConnect

function syncObjects(objs, callback) {
    if (!objs || !objs.length) {
        return callback && callback();
    }
    const task = objs.shift();

    adapter.getForeignObject(task._id, (err, obj) => {
        // add saturation into enum.functions.color
        if (task.common.role === 'level.color.saturation') {
            adapter.getForeignObject('enum.functions.color', (err, _enum) => {
                if (_enum && _enum.common && _enum.common.members && _enum.common.members.indexOf(task._id) === -1) {
                    _enum.common.members.push(task._id);
                    adapter.setForeignObject(_enum._id, _enum, err => {
                        if (!obj) {
                            adapter.setForeignObject(task._id, task, () => setTimeout(syncObjects, 0, objs, callback));
                        } else {
                            obj.native = task.native;
                            adapter.setForeignObject(obj._id, obj, () => setTimeout(syncObjects, 0, objs, callback));
                        }
                    });
                } else {
                    if (!obj) {
                        adapter.setForeignObject(task._id, task, () => setTimeout(syncObjects, 0, objs, callback));
                    } else {
                        obj.native = task.native;
                        adapter.setForeignObject(obj._id, obj, () => setTimeout(syncObjects, 0, objs, callback));
                    }
                }
            });
        } else {
            if (!obj) {
                adapter.setForeignObject(task._id, task, () => setTimeout(syncObjects, 0, objs, callback));
            } else {
                obj.native = task.native;
                adapter.setForeignObject(obj._id, obj, () => setTimeout(syncObjects, 0, objs, callback));
            }
        }
    });
}

function syncStates(states, isChanged, callback) {
    if (!states || !states.length) {
        return callback && callback();
    }
    const task = states.shift();

    if (typeof task.val === 'object' && task.val !== null && task.val !== undefined) {
        task.val = task.val.toString();
    }
    if (isChanged) {
        adapter.setForeignStateChanged(task.id.replace(/\s/g, '_'), task.val, true, () => setTimeout(syncStates, 0, states, isChanged, callback));
    } else {
        adapter.setForeignState(task.id.replace(/\s/g, '_'), task.val, true, () => setTimeout(syncStates, 0, states, isChanged, callback));
    }
}

let pollingState = false;

function poll() {
    if (pollingState)
        return;

    pollingState = true;

    adapter.log.debug('Poll all states');

    submitHueCmd('getFullState', {prio: 5, id: 'getFullState'}, (err, config) => {
        const values = [];
        const lights = config.lights;
        const sensors = config.sensors;
        const groups = config.groups;

        // update sensors
        pollSensors.forEach(sensor => {
            const sensorName = sensor.name;
            sensor = sensors[sensor.id];
            sensor.name = sensorName;
            const states = {};

            const sensorStates = {...sensor.config, ...sensor.state};
            for (const stateA in sensorStates) {
                if (!sensorStates.hasOwnProperty(stateA)) {
                    continue;
                }
                states[stateA] = sensorStates[stateA];
            }

            if (states.temperature !== undefined) {
                states.temperature = convertTemperature(states.temperature);
            }
            for (const stateB in states) {
                if (!states.hasOwnProperty(stateB)) {
                    continue;
                }
                values.push({
                    id: `${adapter.namespace}.${sensor.name}.${stateB}`,
                    val: states[stateB]
                });
            }
        });

        // LIGHTS
        pollLights.forEach(light => {
            const states = {};

            const lightName = light.name;
            light = lights[light.id];
            light.name = lightName;

            if (light.swupdate && light.swupdate.state) {
                values.push({
                    id: `${adapter.namespace}.${light.name}.updateable`,
                    val: light.swupdate.state
                });
            } // endIf

            for (const stateA in light.state) {
                if (!light.state.hasOwnProperty(stateA)) {
                    continue;
                }
                states[stateA] = light.state[stateA];
            }

            if (!adapter.config.ignoreOsram) {
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
                const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
                states.r = Math.round(rgb.Red * 254);
                states.g = Math.round(rgb.Green * 254);
                states.b = Math.round(rgb.Blue * 254);
            }
            if (states.bri !== undefined) {
                states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
            }

            if (states.hue !== undefined) {
                states.hue = Math.round(states.hue / 65535 * 360);
            }
            if (states.ct !== undefined) {
                // convert color temperature from mired to kelvin
                states.ct = Math.round(1e6 / states.ct);
            }
            for (const stateB in states) {
                if (!states.hasOwnProperty(stateB)) {
                    continue;
                }
                values.push({
                    id: `${adapter.namespace}.${light.name}.${stateB}`,
                    val: states[stateB]
                });
            }
        });

        // Create/update groups
        if (!adapter.config.ignoreGroups) {
            pollGroups.forEach(group => {
                // Group 0 needs extra polling
                if (group.id !== '0') {
                    const states = {};
                    const groupName = group.name;
                    group = groups[group.id];
                    group.name = groupName;

                    for (const stateA in group.action) {
                        if (!group.action.hasOwnProperty(stateA)) {
                            continue;
                        }
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
                        const rgb = hueHelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
                        states.r = Math.round(rgb.Red * 254);
                        states.g = Math.round(rgb.Green * 254);
                        states.b = Math.round(rgb.Blue * 254);
                    }
                    if (states.bri !== undefined) {
                        states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
                    }

                    if (states.hue !== undefined) {
                        states.hue = Math.round(states.hue / 65535 * 360);
                    }
                    if (states.ct !== undefined) {
                        // convert color temperature from mired to kelvin
                        states.ct = Math.round(1e6 / states.ct);
                    }

                    for (const stateB in states) {
                        if (!states.hasOwnProperty(stateB)) {
                            continue;
                        }
                        values.push({
                            id: `${adapter.namespace}.${group.name}.${stateB}`,
                            val: states[stateB]
                        });
                    } // endFor
                    // set anyOn state
                    values.push({
                        id: `${adapter.namespace}.${groupName.replace(/\s/g, '_')}.anyOn`,
                        val: group.state['any_on']
                    });
                } else {
                    // poll the 0 - ALL group
                    updateGroupState(group, {prio: 5, id: group.id});
                }
            });
        } // endIf
        syncStates(values, true);
        pollingState = false;
    });
} // endPoll

async function main() {
    adapter.subscribeStates('*');
    adapter.config.port = adapter.config.port ? parseInt(adapter.config.port, 10) : 80;

    // polling interval has to be greater equal 1
    adapter.config.pollingInterval = parseInt(adapter.config.pollingInterval, 10) < 2 ? 2 : parseInt(adapter.config.pollingInterval, 10);

    // create a bottleneck limiter to max 1 cmd per 1 sec
    groupQueue = new Bottleneck({
        reservoir: 1, // initial value
        reservoirRefreshAmount: 1,
        reservoirRefreshInterval: 250 * 4, // must be divisible by 250
        minTime: 25, // wait a minimum of 25 ms between command executions
        highWater: 100 // start to drop older commands if > 100 commands in the queue
    });
    groupQueue.on('depleted', () => {
        adapter.log.debug('groupQueue full. Throttling down...');
    });
    groupQueue.on('error', err => {
        adapter.log.error(`groupQueue error: ${err}`);
    });
    groupQueue.on('retry', (error, jobInfo) => {
        adapter.log.warn(`groupQueue: retry [${jobInfo.retryCount + 1}/10] job ${jobInfo.options.id}`);
    });
    groupQueue.on('failed', async (error, jobInfo) => {
        const id = jobInfo.options.id;
        if (error instanceof hue.ApiError) {
            adapter.log.error(`groupQueue: job ${id} failed: ${error}`);
        } else if (jobInfo.retryCount >= 10) {
            adapter.log.error(`groupQueue: job ${id} max retry reached: ${error}`);
            if (/Api Error: resource, \/groups\/.+, not available,/.test(error)) {
                // seems like a room has been deleted -> resync by restarting adapter
                adapter.log.warn('Room deleted -> restarting adapter to resync');
                const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
                if (obj) adapter.setForeignObject(`system.adapter.${adapter.namespace}`, obj);
            } // endIf
        } else {
            adapter.log.warn(`groupQueue: job ${id} failed: ${error}`);
            return 25; // retry in 25 ms
        }
    });

    // create a bottleneck limiter to max 10 cmd per 1 sec
    lightQueue = new Bottleneck({
        reservoir: 10, // initial value
        reservoirRefreshAmount: 10,
        reservoirRefreshInterval: 1000, // must be divisible by 250
        minTime: 25, // wait a minimum of 25 ms between command executions
        highWater: 1000 // start to drop older commands if > 1000 commands in the queue
    });
    lightQueue.on('depleted', () => {
        adapter.log.debug('lightQueue full. Throttling down...');
    });
    lightQueue.on('error', (err) => {
        adapter.log.error(`lightQueue error: ${err}`);
    });
    lightQueue.on('retry', (error, jobInfo) => {
        adapter.log.warn(`lightQueue: retry [${jobInfo.retryCount + 1}/10] job ${jobInfo.options.id}`);
    });
    lightQueue.on('failed', (error, jobInfo) => {
        const id = jobInfo.options.id;
        if (error instanceof hue.ApiError) {
            adapter.log.error(`lightQueue: job ${id} failed: ${error}`);
        } else if (jobInfo.retryCount >= 10) {
            adapter.log.error(`lightQueue: job ${id} max retry reached: ${error}`);
        } else {
            adapter.log.warn(`lightQueue: job ${id} failed: ${error}`);
            return 25; // retry in 25 ms
        }
    });
    // host, username, clientkey todo: make port configurable again
    api = await v3.api.create(adapter.config.bridge, adapter.config.user, adapter.config.port);//, undefined, undefined, adapter.config.port);
    connect(() => {
        if (adapter.config.polling) {
            pollingInterval = setInterval(poll, adapter.config.pollingInterval * 1000);
            poll();
        }
    });
}

function convertTemperature(value) {
    if (value !== null) {
        value = value.toString();
        const last = value.substring(value.length - 2, value.length);
        const first = value.substring(0, value.length - 2);
        value = `${first}.${last}`;
    } else {
        value = '0';
    }
    return value;
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
