/**
 * Author of helper functions:
 * https://github.com/ArndBrugman/
 *
 */
'use strict';

exports.RgbToXYB = function (Red, Green, Blue, model) {
    const Point = HelperRGBtoXY(Red, Green, Blue);
    const HueAngSatBri = HelperRGBtoHueAngSatBri(Red, Green, Blue);
    const bri = Math.min(255, Math.round(HueAngSatBri.Bri * 255));
    const Gamuted = HelperGamutXYforModel(Point.x, Point.y, model);
    return { x: Gamuted.x, y: Gamuted.y, b: bri };
};

/**
 * @param {float} Red - Range [0..1]
 * @param {float} Green - Range [0..1]
 * @param {float} Blue - Range [0..1]
 * @returns {object} [x, y] - Ranges [0..1] [0..1]
 */
const HelperRGBtoXY = function (Red, Green, Blue) {
    // Source: https://github.com/PhilipsHue/PhilipsHueSDK-iOS-OSX/blob/master/ApplicationDesignNotes/RGB%20to%20xy%20Color%20conversion.md
    // Apply gamma correction
    if (Red > 0.04045) {
        Red = Math.pow((Red + 0.055) / 1.055, 2.4);
    } else {
        Red = Red / 12.92;
    }
    if (Green > 0.04045) {
        Green = Math.pow((Green + 0.055) / 1.055, 2.4);
    } else {
        Green = Green / 12.92;
    }
    if (Blue > 0.04045) {
        Blue = Math.pow((Blue + 0.055) / 1.055, 2.4);
    } else {
        Blue = Blue / 12.92;
    }
    // RGB to XYZ [M] for Wide RGB D65, http://www.developers.meethue.com/documentation/color-conversions-rgb-xy
    const X = Red * 0.664511 + Green * 0.154324 + Blue * 0.162028;
    const Y = Red * 0.283881 + Green * 0.668433 + Blue * 0.047685;
    const Z = Red * 0.000088 + Green * 0.07231 + Blue * 0.986039;
    // But we don't want Capital X,Y,Z you want lowercase [x,y] (called the color point) as per:
    if (X + Y + Z === 0) {
        return { x: 0, y: 0 };
    }
    return { x: X / (X + Y + Z), y: Y / (X + Y + Z) };
};

/**
 * Tests if the Px,Py resides within the Gamut for the model.
 * Otherwise it will calculated the closesed point on the Gamut.
 * @param {float} Px - Range [0..1]
 * @param {float} Py - Range [0..1]
 * @param {string} Model - Modelname of the Light to Gamutcorrect Px, Py for
 * @returns {object} [x, y] - Ranges [0..1] [0..1]
 */
const HelperGamutXYforModel = function (Px, Py, Model) {
    let PRed;
    let PGreen;
    let PBlue;
    let NormDot;

    const gamuts = {
        a: ['LST001', 'LLC010', 'LLC011', 'LLC012', 'LLC006', 'LLC007', 'LLC013'],
        b: ['LCT001', 'LCT007', 'LCT002', 'LCT003', 'LLM001'],
        c: ['LCT010', 'LCT014', 'LCT011', 'LLC020', 'LST002']
    };

    //http://www.developers.meethue.com/documentation/supported-lights
    if (gamuts.b.indexOf(Model) !== -1) {
        // Gamut B
        PRed = { x: 0.675, y: 0.322 };
        PGreen = { x: 0.409, y: 0.518 };
        PBlue = { x: 0.167, y: 0.04 };
    } else if (gamuts.c.indexOf(Model) !== -1) {
        // Gamut C
        PRed = { x: 0.692, y: 0.308 };
        PGreen = { x: 0.17, y: 0.7 };
        PBlue = { x: 0.153, y: 0.048 };
    } else if (gamuts.a.indexOf(Model) !== -1) {
        // Gamut A
        PRed = { x: 0.704, y: 0.296 };
        PGreen = { x: 0.2151, y: 0.7106 };
        PBlue = { x: 0.138, y: 0.08 };
    } else {
        PRed = { x: 1.0, y: 0.0 };
        PGreen = { x: 0.0, y: 1.0 };
        PBlue = { x: 0.0, y: 0.0 };
    }

    const VBR = { x: PRed.x - PBlue.x, y: PRed.y - PBlue.y }; // Blue to Red
    const VRG = { x: PGreen.x - PRed.x, y: PGreen.y - PRed.y }; // Red to Green
    const VGB = { x: PBlue.x - PGreen.x, y: PBlue.y - PGreen.y }; // Green to Blue

    const GBR = (PGreen.x - PBlue.x) * VBR.y - (PGreen.y - PBlue.y) * VBR.x; // Sign Green on Blue to Red
    const BRG = (PBlue.x - PRed.x) * VRG.y - (PBlue.y - PRed.y) * VRG.x; // Sign Blue on Red to Green
    const RGB = (PRed.x - PGreen.x) * VGB.y - (PRed.y - PGreen.y) * VGB.x; // Sign Red on Green to Blue

    const VBP = { x: Px - PBlue.x, y: Py - PBlue.y }; // Blue to Point
    const VRP = { x: Px - PRed.x, y: Py - PRed.y }; // Red to Point
    const VGP = { x: Px - PGreen.x, y: Py - PGreen.y }; // Green to Point

    const PBR = VBP.x * VBR.y - VBP.y * VBR.x; // Sign Point on Blue to Red
    const PRG = VRP.x * VRG.y - VRP.y * VRG.x; // Sign Point on Red to Green
    const PGB = VGP.x * VGB.y - VGP.y * VGB.x; // Sign Point on Green to Blue

    if (GBR * PBR >= 0 && BRG * PRG >= 0 && RGB * PGB >= 0) {
        // All Signs Match so Px,Py must be in triangle
        return { x: Px, y: Py };
    } else if (GBR * PBR <= 0) {
        //  Outside Triangle, Find Closesed point on Edge or Pick Vertice...
        // Outside Blue to Red
        NormDot = (VBP.x * VBR.x + VBP.y * VBR.y) / (VBR.x * VBR.x + VBR.y * VBR.y);
        if (NormDot >= 0.0 && NormDot <= 1.0) {
            // Within Edge
            return { x: PBlue.x + NormDot * VBR.x, y: PBlue.y + NormDot * VBR.y };
        } else if (NormDot < 0.0) {
            // Outside Edge, Pick Vertice
            return { x: PBlue.x, y: PBlue.y }; // Start
        } else {
            return { x: PRed.x, y: PRed.y }; // End
        }
    } else if (BRG * PRG <= 0) {
        // Outside Red to Green
        NormDot = (VRP.x * VRG.x + VRP.y * VRG.y) / (VRG.x * VRG.x + VRG.y * VRG.y);
        if (NormDot >= 0.0 && NormDot <= 1.0) {
            // Within Edge
            return { x: PRed.x + NormDot * VRG.x, y: PRed.y + NormDot * VRG.y };
        } else if (NormDot < 0.0) {
            // Outside Edge, Pick Vertice
            return { x: PRed.x, y: PRed.y }; // Start
        } else {
            return { x: PGreen.x, y: PGreen.y }; // End
        }
    } else if (RGB * PGB <= 0) {
        // Outside Green to Blue
        NormDot = (VGP.x * VGB.x + VGP.y * VGB.y) / (VGB.x * VGB.x + VGB.y * VGB.y);
        if (NormDot >= 0.0 && NormDot <= 1.0) {
            // Within Edge
            return { x: PGreen.x + NormDot * VGB.x, y: PGreen.y + NormDot * VGB.y };
        } else if (NormDot < 0.0) {
            // Outside Edge, Pick Vertice
            return { x: PGreen.x, y: PGreen.y }; // Start
        } else {
            return { x: PBlue.x, y: PBlue.y }; // End
        }
    }
};
exports.GamutXYforModel = HelperGamutXYforModel;

/**
 * @param {float} Red - Range [0..1]
 * @param {float} Green - Range [0..1]
 * @param {float} Blue - Range [0..1]
 * @returns {object} [Ang, Sat, Bri] - Ranges [0..360] [0..1] [0..1]
 */
const HelperRGBtoHueAngSatBri = function (Red, Green, Blue) {
    let Ang;
    let Sat;
    let Bri;
    const Min = Math.min(Red, Green, Blue);
    const Max = Math.max(Red, Green, Blue);
    if (Min !== Max) {
        if (Red === Max) {
            Ang = ((Green - Blue) / (Max - Min)) * 60;
        } else if (Green === Max) {
            Ang = (2 + (Blue - Red) / (Max - Min)) * 60;
        } else {
            Ang = (4 + (Red - Green) / (Max - Min)) * 60;
        }
        Sat = (Max - Min) / Max;
        Bri = Max;
    } else {
        // Max == Min
        Ang = 0;
        Sat = 0;
        Bri = Max;
    }
    return { Ang, Sat, Bri };
};

/**
 * @param {float} x
 * @param {float} y
 * @param {float} Brightness Optional
 * @returns {object} [Red, Green, Blue] - Ranges [0..1] [0..1] [0..1]
 */
const HelperXYBtoRGB = function (x, y, Brightness) {
    // Source: https://github.com/PhilipsHue/PhilipsHueSDK-iOS-OSX/blob/master/ApplicationDesignNotes/RGB%20to%20xy%20Color%20conversion.md
    if (Brightness <= 0) {
        return { Red: 0, Green: 0, Blue: 0 };
    }
    Brightness = Brightness || 1.0; // Default full brightness
    const z = 1.0 - x - y;
    const Y = Brightness;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;
    // XYZ to RGB [M]-1 for Wide RGB D65, http://www.developers.meethue.com/documentation/color-conversions-rgb-xy
    let Red = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let Green = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let Blue = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
    // Limit RGB on [0..1]
    if (Red > Blue && Red > Green && Red > 1.0) {
        // Red is too big
        Green = Green / Red;
        Blue = Blue / Red;
        Red = 1.0;
    }
    if (Red < 0) {
        Red = 0;
    }
    if (Green > Blue && Green > Red && Green > 1.0) {
        // Green is too big
        Red = Red / Green;
        Blue = Blue / Green;
        Green = 1.0;
    }
    if (Green < 0) {
        Green = 0;
    }
    if (Blue > Red && Blue > Green && Blue > 1.0) {
        // Blue is too big
        Red = Red / Blue;
        Green = Green / Blue;
        Blue = 1.0;
    }
    if (Blue < 0) {
        Blue = 0;
    }
    // Apply reverse gamma correction
    if (Red <= 0.0031308) {
        Red = Red * 12.92;
    } else {
        Red = 1.055 * Math.pow(Red, 1.0 / 2.4) - 0.055;
    }
    if (Green <= 0.0031308) {
        Green = Green * 12.92;
    } else {
        Green = 1.055 * Math.pow(Green, 1.0 / 2.4) - 0.055;
    }
    if (Blue <= 0.0031308) {
        Blue = Blue * 12.92;
    } else {
        Blue = 1.055 * Math.pow(Blue, 1.0 / 2.4) - 0.055;
    }
    // Limit RGB on [0..1]
    if (Red > Blue && Red > Green && Red > 1.0) {
        // Red is too big
        Green = Green / Red;
        Blue = Blue / Red;
        Red = 1.0;
    }
    if (Red < 0) {
        Red = 0;
    }
    if (Green > Blue && Green > Red && Green > 1.0) {
        // Green is too big
        Red = Red / Green;
        Blue = Blue / Green;
        Green = 1.0;
    }
    if (Green < 0) {
        Green = 0;
    }
    if (Blue > Red && Blue > Green && Blue > 1.0) {
        // Blue is too big
        Red = Red / Blue;
        Green = Green / Blue;
        Blue = 1.0;
    }
    if (Blue < 0) {
        Blue = 0;
    }
    return { Red, Green, Blue };
};

exports.XYBtoRGB = HelperXYBtoRGB;
