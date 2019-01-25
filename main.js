/**
 *
 *      ioBroker Philips Hue Bridge Adapter
 *
 *      Copyright (c) 2017-2018 Bluefox <dogafox@gmail.com>
 *      Copyright (c) 2014-2016 hobbyquaker *
 *      Apache License
 *
 */
/* jshint -W097 */
/* jshint strict: false */
/* jshint esversion: 6  */
/* jslint node: true */
'use strict';

const hue       = require('node-hue-api');
const utils     = require('@iobroker/adapter-core');
const huehelper = require('./lib/hueHelper');

let adapter;
let commands    = [];
let processing  = false;
let polling     = false;
let pollingInterval;
let reconnectTimeout;

function startAdapter(options) {
    options = options || {};
    Object.assign(options,{
        name:  "hue",
        stateChange:  function (id, state) {
            if (!id || !state || state.ack) {
                return;
            }

            adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));
            const tmp = id.split('.');
            const dp = tmp.pop();
            id = tmp.slice(2).join('.');
            let ls = {};
            // if .on changed instead change .bri to 254 or 0
            let bri = 0;
            if (dp === 'on') {
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
            adapter.getStates(id + '.*', (err, idStates) => {
                if (err) {
                    adapter.log.error(err);
                    return;
                }
                // gather states that need to be changed
                ls = {};
                let alls = {};
                let lampOn = false;
                for (let idState in idStates) {
                    if (!idStates.hasOwnProperty(idState) || idStates[idState].val === null) {
                        continue;
                    }
                    let idtmp = idState.split('.');
                    let iddp = idtmp.pop();
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
                            if (dp === 'command') {
                                try {
                                    let commands = JSON.parse(state.val);
                                    for (let command in commands) {
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
                            alls[iddp] = idStates[idState].val;
                            break;
                        default:
                            alls[iddp] = idStates[idState].val;
                            break;
                    }
                }

                // get lightState
                adapter.getObject(id, (err, obj) => {
                    if (err || !obj) {
                        if (!err) err = new Error('obj "' + id + '" in callback getObject is null or undefined');
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
                        let xyb = huehelper.RgbToXYB(ls.r / 255, ls.g / 255, ls.b / 255, (obj.native.hasOwnProperty('modelid') ? obj.native.modelid.trim() : 'default'));
                        ls.bri = xyb.b;
                        ls.xy = xyb.x + ',' + xyb.y;
                    }

                    // create lightState from ls
                    // and check values
                    let lightState = hue.lightState.create();
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
                                adapter.log.warn('Invalid xy value: "' + ls.xy + '"');
                                ls.xy = '0,0';
                            }
                        }
                        let xy = ls.xy.toString().split(',');
                        xy = {'x': xy[0], 'y': xy[1]};
                        xy = huehelper.GamutXYforModel(xy.x, xy.y, (obj.native.hasOwnProperty('modelid') ? obj.native.modelid.trim() : 'default'));
                        finalLS.xy = xy.x + ',' + xy.y;
                        lightState = lightState.xy(xy.x, xy.y);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                        let rgb = huehelper.XYBtoRGB(xy.x, xy.y, (finalLS.bri / 254));
                        finalLS.r = Math.round(rgb.Red   * 254);
                        finalLS.g = Math.round(rgb.Green * 254);
                        finalLS.b = Math.round(rgb.Blue  * 254);
                    }
                    if ('ct' in ls) {
                        //finalLS.ct = Math.max(153, Math.min(500, ls.ct));
                        finalLS.ct = Math.max(2200, Math.min(6500, ls.ct));
                        finalLS.ct = (500 - 153) - ((finalLS.ct - 2200) / (6500 - 2200)) * (500 - 153) + 153;

                        lightState = lightState.ct(finalLS.ct);
                        if (!lampOn && (!('bri' in ls) || ls.bri === 0)) {
                            lightState = lightState.on();
                            lightState = lightState.bri(254);
                            finalLS.bri = 254;
                            finalLS.on = true;
                        }
                    }
                    if ('hue' in ls) {
                        finalLS.hue = finalLS.hue % 360;
                        if (finalLS.hue < 0) finalLS.hue += 360;
                        finalLS.hue = finalLS.hue / 360 * 65535;
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
                        let transitiontime = parseInt(ls.transitiontime);
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
                        if (alls.hue < 0) alls.hue += 360;
                        alls.hue = alls.hue / 360 * 65535;

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

                    if (obj.common.role === 'LightGroup' || obj.common.role === 'Room') {
                        // log final changes / states
                        adapter.log.debug('final lightState for ' + obj.common.name + ':' + JSON.stringify(finalLS));

                        commands.push({func: 'setGroupLightState', args: [groupIds[id], lightState], ts: Date.now(), context: {
                            id:     id,
                            finalLS: finalLS
                        }, cb: (err, res, context) => {
                            if (err || !res) {
                                adapter.log.error('error: ' + err);
                            }
                            // write back known states
                            for (let finalState in context.finalLS) {
                                if (!context.finalLS.hasOwnProperty(finalState)) {
                                    continue;
                                }
                                if (finalState in alls) {
                                    if (finalState === 'effect') {
                                        adapter.setState([context.id, 'effect'].join('.'), {val: context.finalLS[finalState] === 'colorloop', ack: true});
                                    } else {
                                        adapter.setState([context.id, finalState].join('.'), {val: context.finalLS[finalState], ack: true});
                                    }
                                }
                            }
                        }});

                        setTimeout(processCommands, 50);
                    } else
                    if (obj.common.role === 'switch') {
                        if (finalLS.hasOwnProperty('on')) {
                            finalLS = {on:finalLS.on};
                            // log final changes / states
                            adapter.log.debug('final lightState for ' + obj.common.name + ':' + JSON.stringify(finalLS));

                            lightState = hue.lightState.create();
                            lightState.on(finalLS.on);
                            commands.push({func: 'setLightState', args: [channelIds[id], lightState], ts: Date.now(), context: {
                                id:     id,
                                finalLS: finalLS
                            }, cb: (err, res, context) => {
                                if (err || !res) {
                                    adapter.log.error('error: ' + err);
                                    return;
                                }
                                adapter.setState([context.id, 'on'].join('.'), {val: context.finalLS.on, ack: true});
                            }});

                            setTimeout(processCommands, 50);
                        } else {
                            adapter.log.warn('invalid switch operation');
                        }
                    } else {
                        // log final changes / states
                        adapter.log.debug('final lightState for ' + obj.common.name + ':' + JSON.stringify(finalLS));
                        commands.push({func: 'setLightState', args: [channelIds[id], lightState], ts: Date.now(), context: {
                            id:     id,
                            finalLS: finalLS
                        }, cb: (err, res, context) => {
                            if (err || !res) {
                                adapter.log.error('error: ' + err);
                                return;
                            }
                            // write back known states
                            for (let finalState in context.finalLS) {
                                if (!context.finalLS.hasOwnProperty(finalState)) {
                                    continue;
                                }
                                if (finalState in alls) {
                                    if (finalState === 'hue') {
                                        context.finalLS[finalState] = context.finalLS[finalState] / 65535 * 360;
                                        adapter.setState([context.id, finalState].join('.'), {val: context.finalLS[finalState], ack: true});
                                    } else
                                    if (finalState === 'ct') {
                                        context.finalLS[finalState] = (6500 - 2200) - ((context.finalLS[finalState] - 153) / (500 - 153)) * (6500 - 2200) + 2200;
                                        adapter.setState([context.id, finalState].join('.'), {val: context.finalLS[finalState], ack: true});
                                    } else
                                    if (finalState === 'effect') {
                                        adapter.setState([context.id, 'effect'].join('.'), {val: context.finalLS[finalState] === 'colorloop', ack: true});
                                    } else {
                                        adapter.setState([context.id, finalState].join('.'), {val: context.finalLS[finalState], ack: true});
                                    }
                                }
                            }
                        }});

                        setTimeout(processCommands, 50);
                    }
                });
            });
        },
        message: function (obj) {
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
                        adapter.log.warn("Unknown command: " + obj.command);
                        break;
                }
            }
            if (!wait && obj.callback) {
                adapter.sendTo(obj.from, obj.command, obj.message, obj.callback);
            }
            return true;
        },
        ready: function () {
            main();
        },
        unload: function (callback) {
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

let times = [];

function processCommands() {
    if (!commands.length) {
        processing = false;
        return;
    }

    // move lightStatus to the end
    let processedCommand;
    if (processing) {
        // remove processed command from list
        processedCommand = commands.shift();
    }
    commands.sort((a, b) => {
        const _a = a.func === 'lightStatus' || a.func === 'getGroup' || a.func === 'getFullState';
        const _b = b.func === 'lightStatus' || b.func === 'getGroup' || b.func === 'getFullState';

        if (!_a && !_b) return 0;
        if (_a && !_b) return 1;
        return -1;
    });

    // Combine commands
    let command = commands[0];
    const len = commands.length;
    let newCommand = null;
    let _values = null;
    // find last similar command in the queue
    for (let c = commands.length - 1; c >= 0; c--) {
        if (command.func === commands[c].func && command.args[0] === commands[c].args[0]) {
            if (commands[c].args[1] && command.args[1]) {
                if (commands[c].args[1]._values && command.args[1]._values) {
                    _values = _values || {};
                    for (const attr in commands[c].args[1]._values) {
                        if (commands[c].args[1]._values.hasOwnProperty(attr) && _values[attr] === undefined) {
                            _values[attr] = commands[c].args[1]._values[attr];
                        }
                    }
                } else if (JSON.stringify(commands[c].args[1]) !== JSON.stringify(command.args[1])) {
                    continue;
                }
                if (!newCommand) {
                    newCommand = commands[c];
                }
            } else if (c) {
                if (!newCommand) {
                    newCommand = commands[c];
                }
            } else {
                continue;
            }
            if (commands[c] === newCommand) {
                console.log(
                    '=> Remove command "' + command.func + '" ' + JSON.stringify(command.args) + '\n' +
                    '=>                     because of ' + JSON.stringify(newCommand.args));
            } else {
                console.log(
                    '=> Remove command "' + commands[c].func + '" ' + JSON.stringify(commands[c].args) + '\n' +
                    '=>                     because of ' + JSON.stringify(newCommand.args));
            }
            commands.splice(c, 1);
        }
    }

    if (newCommand) {
        commands.unshift(newCommand);
        command = newCommand;
        if (_values) {
            newCommand.args[1]._values = _values;
            if (_values.on === false) {
                if (_values.xy !== undefined) delete _values.xy;
                if (_values.bri !== undefined) delete _values.bri;
            }
        }
        console.log('=> Was ' + len + ' now ' + commands.length);
    }

    const now = Date.now();

    if (!adapter.config.dontUseQueue) {
        if (processing) {
            commands.unshift(processedCommand);
            if (polling && command && command.func === 'setLightState') {
                // if polling force executing of commands
                // we may send only 10 commands in 10 seconds
                if (times.length >= 10) {
                    const diff = now - times[0] - 10500;
                    if (diff > 0) {
                        // delete all commands older than 11 seconds
                        while (times.length && now - times[0] > 10500) {
                            times.shift();
                        }

                        times.push(now);

                        const command = commands.shift(); // delete immediately command from queue and send to device
                        api[command.func](command.args[0], command.args[1], (err, result) => {
                            command.cb && command.cb(err, result, command.context);
                        });
                    }
                }
            }

            return;
        }
        // we may send only 10 commands in 10 seconds
        if (times.length >= 10) {
            const diff = now - times[0] - 10500;

            if (diff < 0) {
                adapter.log.debug(`Too many commands. Wait for ${-diff} ms`);
                setTimeout(processCommands, -diff);
                return;
            }
        }
        // delete all commands older than 11 seconds
        while (times.length && now - times[0] > 10500) {
            times.shift();
        }
        console.log('=> Execute after ' + (Date.now() - command.ts) + ' ms => ' + command.func + ', ' + command.args[0] + ', ' + JSON.stringify(command.args[1]));

        times.push(now);
        processing = true;
        if (command.func === 'lightStatus' || command.func === 'getGroup' || command.func === 'getFullState') {
            polling = true;
        }
    } else {
        commands.shift();
        setTimeout(processCommands, 0);
    }

    if (!command.args || command.args.length === 0) {
        api[command.func]((err, result) => {
            command.cb && command.cb(err, result, command.context);
            polling = false;
            if (!adapter.config.dontUseQueue) {
                commands.shift();
                setTimeout(() => {
                    processing = false;
                    processCommands();
                }, 50);
            }
        });
    } else if (command.args.length === 1) {
        api[command.func](command.args[0], (err, result) => {
            command.cb && command.cb(err, result, command.context);
            polling = false;
            if (!adapter.config.dontUseQueue) {
                commands.shift();
                setTimeout(() => {
                    processing = false;
                    processCommands();
                }, 50);
            }
        });
    } else if (command.args.length === 2) {
        api[command.func](command.args[0], command.args[1], (err, result) => {
            command.cb && command.cb(err, result, command.context);
            if (!adapter.config.dontUseQueue) {
                commands.shift();
                setTimeout(() => {
                    processing = false;
                    processCommands();
                }, 50);
            }
        });
    }
}

function browse(timeout, callback) {
    timeout = parseInt(timeout);
    if (isNaN(timeout)) timeout = 5000;
    hue.upnpSearch(timeout).then(callback).done();
}

function createUser(ip, callback) {
    let newUserName = null;
    let userDescription = 'ioBroker.hue';
    try {
        let api = new HueApi();
        api.registerUser(ip, newUserName, userDescription)
            .then(newUser => {
                adapter.log.info('created new User: ' + newUser);
                callback({error: 0, message: newUser});
            })
            .fail(err => {
                callback({error: err.type || err, message: err.message});
            })
            .done();
    } catch (e) {
        adapter.log.error(e);
        callback({error: 1, message: JSON.stringify(e)});
    }
}

let HueApi = hue.HueApi;
let api;

let channelIds     = {};
let channelSWIds     = {};
let pollIds        = [];
let pollSWIds      = [];
let pollSWOrgIds      = [];
let pollChannels   = [];
let pollSWChannels = [];
let groupIds       = {};
let pollGroups     = [];

function connect(cb) {
    api.getFullState((err, config) => {
        if (err) {
            adapter.log.warn('could not connect to ip');
            reconnectTimeout = setTimeout(connect, 5000, cb);
            return;
        } else if (!config) {
            adapter.log.warn('Cannot get the configuration from hue bridge');
            reconnectTimeout = setTimeout(connect, 5000, cb);
            return;
        }

        let channelNames = [];

        // Create/update lamps
        adapter.log.info('creating/updating switch channels');

        let lights  = config.lights;
        let sensors = config.sensors;
        let count   = 0;
        let objs    = [];
        let states  = [];

        for (let sid in sensors) {
            if (!sensors.hasOwnProperty(sid)) {
                continue;
            }

            count++;
            let sensor = sensors[sid];

            let channelName = config.config.name + '.' + sensor.name;
            if (channelNames.indexOf(channelName) !== -1) {
                adapter.log.warn('channel "' + channelName + '" already exists, skipping lamp');
                continue;
            } else {
                channelNames.push(channelName);
            }
            channelSWIds[channelName.replace(/\s/g, '_')] = sid;
            pollSWChannels.push(channelName.replace(/\s/g, '_'));

            if (sensor.type === 'ZLLSwitch' || sensor.type === 'ZGPSwitch' || sensor.type=='Daylight' || sensor.type=='ZLLTemperature' || sensor.type=='ZLLPresence' || sensor.type=='ZLLLightLevel') {
               pollSWIds.push(count);
               pollSWOrgIds.push(sid);

               let sensorName =  sensor.name.replace(/\s/g, '');
               
               for (let state in sensor.state) {
                  if (!sensor.state.hasOwnProperty(state)) {
                      continue;
                  }
                  let objId = channelName  + '.' + state;
  
                  let lobj = {
                      _id:        adapter.namespace + '.' + objId.replace(/\s/g, '_'),
                      type:       'state',
                      common: {
                          name:   objId.replace(/\s/g, '_'),
                          read:   true,
                          write:  true
                      },
                      native: {
                          id:     sid
                      }
                  };
  
                  switch (state) {
                      case 'on':
                          lobj.common.type = 'boolean';
                          lobj.common.role = 'switch';
                          break;
                      case 'reachable':
                          lobj.common.type  = 'boolean';
                          lobj.common.write = false;
                          lobj.common.role  = 'indicator.reachable';
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
                          lobj.common.min  = 0;
                          lobj.common.max  = 17000;
                          break;
                      case 'temperature':
                          lobj.common.type = 'number';
                          lobj.common.role = 'indicator.temperature';
                          break;
                      default:
                          adapter.log.info('skip switch: ' + objId);
                          break;
                  }
  
                  objs.push(lobj);
                  
                  var value = sensor.state[state];
                  if (state === 'temperature'){
                	  value = convertTemperature(value);
                  }
                  states.push({id: lobj._id, val: value});
               }
           }
        }

        adapter.log.info('created/updated ' + count + ' switch channels');

        count = 0;

        for (let lid in lights) {
            if (!lights.hasOwnProperty(lid)) {
                continue;
            }
            count++;
            let light = lights[lid];

            let channelName = config.config.name + '.' + light.name;
            if (channelNames.indexOf(channelName) !== -1) {
                adapter.log.warn('channel "' + channelName + '" already exists, skipping lamp');
                continue;
            } else {
                channelNames.push(channelName);
            }
            channelIds[channelName.replace(/\s/g, '_')] = lid;
            pollIds.push(lid);
            pollChannels.push(channelName.replace(/\s/g, '_'));

            if (light.type === 'Extended color light' || light.type === 'Color light') {
                light.state.r = 0;
                light.state.g = 0;
                light.state.b = 0;
            }

            if (light.type !== 'On/Off plug-in unit') {
                light.state.command = '{}';
                light.state.level = 0;
            }

            for (let state in light.state) {
                if (!light.state.hasOwnProperty(state)) {
                    continue;
                }
                let objId = channelName + '.' + state;

                let lobj = {
                    _id:        adapter.namespace + '.' + objId.replace(/\s/g, '_'),
                    type:       'state',
                    common: {
                        name:   objId.replace(/\s/g, '_'),
                        read:   true,
                        write:  true
                    },
                    native: {
                        id:     lid
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
                        lobj.common.min  = 0;
                        lobj.common.max  = 254;
                        break;
                    case 'level':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.dimmer';
                        lobj.common.min  = 0;
                        lobj.common.max  = 100;
                        break;
                    case 'hue':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.hue';
                        lobj.common.unit = '°';
                        lobj.common.min  = 0;
                        lobj.common.max  = 360;
                        break;
                    case 'sat':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.saturation';
                        lobj.common.min  = 0;
                        lobj.common.max  = 254;
                        break;
                    case 'xy':
                        lobj.common.type = 'string';
                        lobj.common.role = 'level.color.xy';
                        break;
                    case 'ct':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.temperature';
                        lobj.common.unit = '°K';
                        lobj.common.min  = 2200; // 500
                        lobj.common.max  = 6500; // 153
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
                        lobj.common.type  = 'string';
                        lobj.common.role  = 'colormode';
                        lobj.common.write = false;
                        break;
                    case 'reachable':
                        lobj.common.type  = 'boolean';
                        lobj.common.write = false;
                        lobj.common.role  = 'indicator.reachable';
                        break;
                    case 'r':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.red';
                        lobj.common.min  = 0;
                        lobj.common.max  = 255;
                        break;
                    case 'g':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.green';
                        lobj.common.min  = 0;
                        lobj.common.max  = 255;
                        break;
                    case 'b':
                        lobj.common.type = 'number';
                        lobj.common.role = 'level.color.blue';
                        lobj.common.min  = 0;
                        lobj.common.max  = 255;
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
                        adapter.log.info('skip light: ' + objId);
                        break;
                }

                objs.push(lobj);
                states.push({id: lobj._id, val: light.state[state]});
            }

            let role = 'light.color';
            if (light.type === 'Dimmable light' || light.type === 'Dimmable plug-in unit') {
                role = 'light.dimmer';
            } else if (light.type === 'On/Off plug-in unit') {
                role = 'switch';
            }

            objs.push({
                _id: adapter.namespace + '.' + channelName.replace(/\s/g, '_'),
                type: 'channel',
                common: {
                    name:           channelName.replace(/\s/g, '_'),
                    role:           role
                },
                native: {
                    id:             lid,
                    type:           light.type,
                    name:           light.name,
                    modelid:        light.modelid,
                    swversion:      light.swversion,
                    pointsymbol:    light.pointsymbol
                }
            });

        }
        adapter.log.info('created/updated ' + count + ' light channels');

        // Create/update groups
        adapter.log.info('creating/updating light groups');

        if (!adapter.config.ignoreGroups) {
            let groups = config.groups;
            groups[0] = {
                name: 'All',   //"Lightset 0"
                type: 'LightGroup',
                id: 0,
                action: {
                    alert:  'select',
                    bri:    0,
                    colormode: '',
                    ct:     0,
                    effect: 'none',
                    hue:    0,
                    on:     false,
                    sat:    0,
                    xy:     '0,0'
                }
            };
            count = 0;
            for (let gid in groups) {
                if (!groups.hasOwnProperty(gid)) {
                    continue;
                }
                count += 1;
                let group = groups[gid];

                let groupName = config.config.name + '.' + group.name;
                if (channelNames.indexOf(groupName) !== -1) {
                    adapter.log.warn('channel "' + groupName + '" already exists, skipping group');
                    continue;
                } else {
                    channelNames.push(groupName);
                }
                groupIds[groupName.replace(/\s/g, '_')] = gid;
                pollGroups.push({id: gid, name: groupName.replace(/\s/g, '_')});

                group.action.r      = 0;
                group.action.g      = 0;
                group.action.b      = 0;
                group.action.command = '{}';
                group.action.level  = 0;

                for (let action in group.action) {
                    if (!group.action.hasOwnProperty(action)) {
                        continue;
                    }

                    let gobjId = groupName + '.' + action;

                    let gobj = {
                        _id:        adapter.namespace + '.' + gobjId.replace(/\s/g, '_'),
                        type:       'state',
                        common: {
                            name:   gobjId.replace(/\s/g, '_'),
                            read:   true,
                            write:  true
                        },
                        native: {
                            id:     gid
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
                            gobj.common.min  = 0;
                            gobj.common.max  = 254;
                            break;
                        case 'level':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.dimmer';
                            gobj.common.min  = 0;
                            gobj.common.max  = 100;
                            break;
                        case 'hue':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.hue';
                            gobj.common.unit = '°';
                            gobj.common.min  = 0;
                            gobj.common.max  = 360;
                            break;
                        case 'sat':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.saturation';
                            gobj.common.min  = 0;
                            gobj.common.max  = 254;
                            break;
                        case 'xy':
                            gobj.common.type = 'string';
                            gobj.common.role = 'level.color.xy';
                            break;
                        case 'ct':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.temperature';
                            gobj.common.unit = '°K';
                            gobj.common.min  = 2200; // 500
                            gobj.common.max  = 6500; // 153
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
                            gobj.common.min  = 0;
                            gobj.common.max  = 255;
                            break;
                        case 'g':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.green';
                            gobj.common.min  = 0;
                            gobj.common.max  = 255;
                            break;
                        case 'b':
                            gobj.common.type = 'number';
                            gobj.common.role = 'level.color.blue';
                            gobj.common.min  = 0;
                            gobj.common.max  = 255;
                            break;
                        case 'command':
                            gobj.common.type = 'string';
                            gobj.common.role = 'command';
                            break;
                        default:
                            adapter.log.info('skip group: ' + gobjId);
                            continue;
                    }
                    objs.push(gobj);
                    states.push({id: gobj._id, val: group.action[action]});
                }

                objs.push({
                    _id:        adapter.namespace + '.' + groupName.replace(/\s/g, '_'),
                    type:       'channel',
                    common: {
                        name:   groupName.replace(/\s/g, '_'),
                        role:   group.type
                    },
                    native: {
                        id:     gid,
                        type:   group.type,
                        name:   group.name,
                        lights: group.lights
                    }
                });
            }
            adapter.log.info('created/updated ' + count + ' light groups');

        }

        // Create/update device
        adapter.log.info('creating/updating bridge device');
        objs.push({
            _id:    adapter.namespace + '.' + config.config.name.replace(/\s/g, '_'),
            type: 'device',
            common: {
                name: config.config.name.replace(/\s/g, '_')
            },
            native: config.config
        });

        syncObjects(objs, () => syncStates(states, false, cb))
    });
}

function syncObjects(objs, callback) {
    if (!objs || !objs.length) {
        return callback && callback();
    }
    let task = objs.shift();

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
    let task = states.shift();

    if (typeof task.val === 'object' && task.val !== null && task.val !== undefined) {
        task.val = task.val.toString();
    }
    if (isChanged) {
        adapter.setForeignStateChanged(task.id, task.val, true, () => setTimeout(syncStates, 0, states, isChanged, callback));
    } else {
        adapter.setForeignState(task.id, task.val, true, () => setTimeout(syncStates, 0, states, isChanged, callback));
    }
}

function pollGroup(count, callback) {
    if (typeof count === 'function') {
        callback = count;
        count = 0;
    }
    count = count || 0;

    if (adapter.config.ignoreGroups || count >= pollGroups.length) {
        callback && callback();
    } else {
        adapter.log.debug('polling group ' + pollGroups[count].name);

        let context = {
            count: count,
            // give 10 seconds to bridge for answer
            timeout: setTimeout(() => {
                adapter.log.error('Timeout for polling group ' + pollGroups[count].id);
                context.timeout = null;
                pollGroup(count + 1, callback);
            }, 10000)
        };

        commands.push({func: 'getGroup', args: [pollGroups[count].id], context: context, ts: Date.now(), cb: (err, result, context) => {
            adapter.log.debug('polling group result ' + JSON.stringify(result));
            if (!context.timeout) return;
            clearTimeout(context.timeout);

            let values = [];
            if (err) {
                adapter.log.error(err);
            }
            if (!result) {
                adapter.log.error('Cannot get result for lightStatus' + pollIds[context.count]);
            } else {
                let states = {};
                for (let stateA in result.lastAction) {
                    if (!result.lastAction.hasOwnProperty(stateA)) {
                        continue;
                    }
                    states[stateA] = result.lastAction[stateA];
                }
                if (states.reachable === false && states.bri !== undefined) {
                    states.bri = 0;
                    states.on = false;
                }
                if (states.on === false && states.bri !== undefined) {
                    states.bri = 0;
                }
                if (states.xy !== undefined) {
                    let xy = states.xy.toString().split(',');
                    states.xy = states.xy.toString();
                    let rgb = huehelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
                    states.r = Math.round(rgb.Red   * 254);
                    states.g = Math.round(rgb.Green * 254);
                    states.b = Math.round(rgb.Blue  * 254);
                }
                if (states.bri !== undefined) {
                    states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
                }
                for (let stateB in states) {
                    if (!states.hasOwnProperty(stateB)) {
                        continue;
                    }
                    values.push({id: adapter.namespace + '.' + pollGroups[context.count].name + '.' + stateB, val: states[stateB]});
                }
            }
            syncStates(values, true, () => setTimeout(pollGroup, 50, context.count + 1, callback));
        }});

        setTimeout(processCommands, 50);
    }
}

function pollSingle(count, callback) {
    if (typeof count === 'function') {
        callback = count;
        count = 0;
    }
    count = count || 0;

    if (count >= pollIds.length) {
        callback && callback();
    } else {
        adapter.log.debug('polling light ' + pollChannels[count]);

        let context = {
            count: count,
            // give 10 seconds to bridge for answer
            timeout: setTimeout(() => {
                adapter.log.error('Timeout for polling light ' + pollChannels[count]);
                context.timeout = null;
                pollSingle(count + 1, callback);
            }, 10000)
        };

        commands.push({func: 'lightStatus', args: [pollIds[count]], context: context, ts: Date.now(), cb: (err, result, context) => {
            if (!context.timeout) return;
            clearTimeout(context.timeout);
            adapter.log.debug('polling light result ' + JSON.stringify(result));

            let values = [];
            if (err) {
                adapter.log.error(err);
            }
            if (!result) {
                adapter.log.error('Cannot get result for lightStatus' + pollIds[context.count]);
            } else {
                let states = {};
                for (let stateA in result.state) {
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
                    let xy = states.xy.toString().split(',');
                    states.xy = states.xy.toString();
                    let rgb = huehelper.XYBtoRGB(xy[0], xy[1], (states.bri / 254));
                    states.r = Math.round(rgb.Red   * 254);
                    states.g = Math.round(rgb.Green * 254);
                    states.b = Math.round(rgb.Blue  * 254);
                }
                if (states.bri !== undefined) {
                    states.level = Math.max(Math.min(Math.round(states.bri / 2.54), 100), 0);
                }
                for (let stateB in states) {
                    if (!states.hasOwnProperty(stateB)) {
                        continue;
                    }
                    values.push({id: adapter.namespace + '.' + pollChannels[context.count] + '.' + stateB, val: states[stateB]});
                }
            }
            syncStates(values, true, () => setTimeout(pollSingle, 50, context.count + 1, callback));
        }});

        setTimeout(processCommands, 50);
    }
}

function pollSwitch(count, callback) {
    if (typeof count === 'function') {
        callback = count;
        count = 0;
    }
    count = count || 0;

    if (count >= pollSWOrgIds.length) {
        callback && callback();
    } else {
        adapter.log.debug('polling switch ' + pollSWChannels[count]);

        let context = {
            count: count,
            // give 10 seconds to bridge for answer
            timeout: setTimeout(() => {
                adapter.log.error('Timeout for polling switch ' + pollSWChannels[count]);
                context.timeout = null;
                pollSwitch(count + 1, callback);
            }, 10000)
        };

        commands.push({func: 'getFullState', args: [], context: context, ts: Date.now(), cb: (err, config, context) => {
            adapter.log.debug('polling group switch ' + JSON.stringify(config));
            if (!context.timeout) return;
            clearTimeout(context.timeout);

            adapter.log.debug('updating switch');

            let sensors = config.sensors;
            let states  = [];

            for (let ind = 0; ind <= pollSWOrgIds.length; ind++) {
                if (!pollSWOrgIds.hasOwnProperty(ind)) {
                    continue;
                }
                let sid = pollSWOrgIds[ind];
                let sensor = sensors[sid];

                let channelName = config.config.name + '.' + sensor.name;

                for (let state in sensor.state) {
                    if (!sensor.state.hasOwnProperty(state)) {
                        continue;
                    }
                    let objId = channelName + '.' + state;

                    let lobj = {
                        _id:        adapter.namespace + '.' + objId.replace(/\s/g, '_'),
                        type:       'state',
                        common: {
                            name:   objId.replace(/\s/g, '_'),
                            read:   true,
                            write:  true
                        },
                        native: {
                            id:     sid
                        }
                    };
                    var value = sensor.state[state];
                    if (state === 'temperature') {
                    	value = convertTemperature(value);
    				}
                    
                    states.push({id: lobj._id, val: value});
                }
            }
            syncStates(states, true, () => setTimeout(pollSwitch, 50, context.count + 1, callback));
        }});

        setTimeout(processCommands, 50);
    }
}
let pollingState = false;
function poll() {
    if (pollingState) return;
    pollingState = true;
    pollSingle(() => {
        pollGroup(() => {
            pollSwitch(() => {
                pollingState = false;
            });
        })
    })
}

function main() {
    adapter.subscribeStates('*');
    if (!adapter.config.port) {
        adapter.config.port = 80;
    } else {
        adapter.config.port = parseInt(adapter.config.port, 10);
    }
    adapter.config.pollingInterval = parseInt(adapter.config.pollingInterval, 10);
    if (adapter.config.pollingInterval < 5) {
        adapter.config.pollingInterval = 5;
    }

    api = new HueApi(adapter.config.bridge, adapter.config.user, 0, adapter.config.port);

    connect(() => {
        if (adapter.config.polling) {
            pollingInterval = setInterval(poll, adapter.config.pollingInterval * 1000);
            poll();
        }
    });
}

function convertTemperature(value) {
	if (value !== null){
		value = value.toString();
		var last = value.substring(value.length - 2, value.length);
		var first = value.substring(0, value.length - 2);
		value = first + "." + last;
	} else {
		value = "0";
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