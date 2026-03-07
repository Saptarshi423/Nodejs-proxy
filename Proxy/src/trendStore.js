'use strict';

/**
 * trendStore.js
 *
 * In-memory ring buffer store for trend history, one buffer per gage (0-6).
 * Older entries are dropped automatically when the buffer is full.
 *
 * MAX_TREND_POINTS is read from environment (default 101), matching the
 * PNet4 device's own internal ring buffer size for trend data.
 */

const MAX_POINTS = parseInt(process.env.MAX_TREND_POINTS, 10) || 101;

/** Number of supported gage channels */
const GAGE_COUNT = 7; // gages 0 through 6

/**
 * Internal store: an array of arrays, one per gage.
 * Each inner array holds up to MAX_POINTS scan objects (oldest first).
 *
 * @type {Array<Array<Object>>}
 */
const _store = Array.from({ length: GAGE_COUNT }, () => []);

/**
 * Adds a parsed scan object to the ring buffer for the appropriate gage.
 * If the buffer is full (length === MAX_POINTS), the oldest entry is removed.
 *
 * @param {Object} scanObj  - parsed scan object from parser.js
 */
function addPoint(scanObj) {
    const gageNo = scanObj.gage;

    if (gageNo < 0 || gageNo >= GAGE_COUNT) {
        console.warn(`[${new Date().toISOString()}] trendStore: ignoring out-of-range gage number ${gageNo}`);
        return;
    }

    const buf = _store[gageNo];

    if (buf.length >= MAX_POINTS) {
        buf.shift(); // drop oldest entry
    }

    buf.push(scanObj);
}

/**
 * Returns all stored points for a gage, ordered oldest first.
 * Returns an empty array if the gage number is invalid.
 *
 * @param {number} gageNo   - gage number (0-6)
 * @returns {Array<Object>}
 */
function getHistory(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) return [];
    // Return a shallow copy to prevent external mutation of internal buffer
    return [..._store[gageNo]];
}

/**
 * Returns an object keyed by gage number (as strings) where each value
 * is the history array for that gage.
 *
 * @returns {Object.<string, Array<Object>>}
 */
function getAllGages() {
    const result = {};
    for (let i = 0; i < GAGE_COUNT; i++) {
        result[i] = [..._store[i]];
    }
    return result;
}

/**
 * Clears the trend history for a specific gage.
 *
 * @param {number} gageNo   - gage number (0-6)
 */
function clear(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) {
        console.warn(`[${new Date().toISOString()}] trendStore: cannot clear invalid gage number ${gageNo}`);
        return;
    }
    _store[gageNo] = [];
    console.log(`[${new Date().toISOString()}] trendStore: cleared history for gage ${gageNo}`);
}

/**
 * Returns the current number of stored points for a gage.
 * Useful for diagnostics and health checks.
 *
 * @param {number} gageNo
 * @returns {number}
 */
function getCount(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) return 0;
    return _store[gageNo].length;
}

module.exports = {
    addPoint,
    getHistory,
    getAllGages,
    clear,
    getCount,
    MAX_POINTS,
    GAGE_COUNT,
};
