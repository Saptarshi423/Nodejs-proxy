'use strict';

/**
 * measStore.js
 *
 * In-memory ring buffer store for INLINE gage readings, one buffer per gage (0-6).
 * Older entries are dropped automatically when the buffer is full.
 *
 * MEAS_RING_SIZE is read from environment (default 200).
 */

const MAX_POINTS    = parseInt(process.env.MEAS_RING_SIZE,     10) || 200;
const SMOOTH_WINDOW = parseInt(process.env.MEAS_SMOOTH_WINDOW, 10) || 10;

/** Number of supported gage channels */
const GAGE_COUNT = 7; // gages 0 through 6

/**
 * Internal store: an array of arrays, one per gage.
 * Each inner array holds up to MAX_POINTS reading objects (oldest first).
 *
 * @type {Array<Array<Object>>}
 */
const _store = Array.from({ length: GAGE_COUNT }, () => []);

/**
 * Per-gage smoothing state for the sliding-window average.
 * Mirrors the Java InlineNet.smoothMeas() algorithm exactly:
 *   - Maintains a running sum so each update is O(1)
 *   - Window grows until SMOOTH_WINDOW samples are available,
 *     then slides (drops oldest, adds newest)
 *
 * @type {Array<{sum: number, count: number}>}
 */
const _smooth = Array.from({ length: GAGE_COUNT }, () => ({ sum: 0, count: 0 }));

/**
 * Computes the smoothed value for a new reading using a sliding-window average.
 * Must be called BEFORE the new reading is pushed onto buf.
 *
 * @param {number}        gageNo  - gage index (0-6)
 * @param {number}        value   - raw reading value
 * @param {Array<Object>} buf     - current ring buffer for this gage (before push)
 * @returns {number}              - smoothed value
 */
function _computeSmooth(gageNo, value, buf) {
    const s = _smooth[gageNo];

    if (SMOOTH_WINDOW <= 1) return value;

    if (s.count < SMOOTH_WINDOW) {
        // Window still filling — growing average
        s.sum += value;
        s.count++;
    } else {
        // Steady state — drop the reading that falls off the back of the window.
        // buf[buf.length - SMOOTH_WINDOW] is the oldest reading in the current window
        // (the new value hasn't been pushed yet, so buf.length reflects the old state).
        const dropping = buf[buf.length - SMOOTH_WINDOW];
        s.sum -= dropping.value;
        s.sum += value;
        // s.count stays at SMOOTH_WINDOW
    }

    return s.sum / s.count;
}

/**
 * Adds an array of parsed readings to the ring buffer for the specified gage.
 * If the buffer would exceed MAX_POINTS, oldest entries are dropped first.
 *
 * @param {number}        gageNo        - gage number (0-6)
 * @param {Array<Object>} readingsArray - array of reading objects from parseMeasBatch
 */
function addReadings(gageNo, readingsArray) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) {
        console.warn(`[${new Date().toISOString()}] measStore: ignoring out-of-range gage number ${gageNo}`);
        return;
    }

    const buf = _store[gageNo];

    for (const reading of readingsArray) {
        // Compute smoothValue before pushing (the algorithm needs the pre-push buffer)
        reading.smoothValue = _computeSmooth(gageNo, reading.value, buf);

        if (buf.length >= MAX_POINTS) {
            buf.shift(); // drop oldest entry
        }
        buf.push(reading);
    }
}

/**
 * Returns all stored readings for a gage, ordered oldest first.
 * Returns an empty array if the gage number is invalid.
 *
 * @param {number} gageNo   - gage number (0-6)
 * @returns {Array<Object>}
 */
function getHistory(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) return [];
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
 * Clears the reading history for a specific gage.
 *
 * @param {number} gageNo   - gage number (0-6)
 */
function clear(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) {
        console.warn(`[${new Date().toISOString()}] measStore: cannot clear invalid gage number ${gageNo}`);
        return;
    }
    _store[gageNo] = [];
    _smooth[gageNo] = { sum: 0, count: 0 };
    console.log(`[${new Date().toISOString()}] measStore: cleared history for gage ${gageNo}`);
}

/**
 * Returns the current number of stored readings for a gage.
 *
 * @param {number} gageNo
 * @returns {number}
 */
function getCount(gageNo) {
    if (gageNo < 0 || gageNo >= GAGE_COUNT) return 0;
    return _store[gageNo].length;
}

module.exports = {
    addReadings,
    getHistory,
    getAllGages,
    clear,
    getCount,
    MAX_POINTS,
    GAGE_COUNT,
};
