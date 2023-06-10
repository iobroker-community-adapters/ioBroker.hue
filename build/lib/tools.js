"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isObject = void 0;
/**
 * Tests whether the given variable is a real object and not an Array
 * @param it The variable to test
 */
function isObject(it) {
    return Object.prototype.toString.call(it) === '[object Object]';
}
exports.isObject = isObject;
//# sourceMappingURL=tools.js.map