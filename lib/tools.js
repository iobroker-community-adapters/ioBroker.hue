/**
 * Tests whether the given variable is a real object and not an Array
 * @param {any} it The variable to test
 * @returns {boolean}
 */
function isObject(it) {
    // This is necessary because:
    // typeof null === 'object'
    // typeof [] === 'object'
    // [] instanceof Object === true
    return Object.prototype.toString.call(it) === '[object Object]'; // this code is 25% faster then below one
    // return it && typeof it === 'object' && !(it instanceof Array);
}

module.exports = {
    isObject
};
