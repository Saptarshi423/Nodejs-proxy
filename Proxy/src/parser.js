'use strict';

/**
 * parser.js
 *
 * Parses binary scan data packets from the PNet4 device (NDC Technologies).
 * All multi-byte fields are big-endian unless noted otherwise.
 *
 * Packet layout (512-bucket mode, 2682 bytes total):
 *
 *  Offset  Size  Type      Field
 *  ------  ----  --------  -----------
 *  0       4     uint32BE  gage_number   (0-6)
 *  4       1     uint8     data_type
 *  5       1     uint8     scan_dir
 *  6       8     doubleBE  min_scan
 *  14      8     doubleBE  max_scan
 *  22      8     doubleBE  bkt_wdth
 *  30      8     doubleBE  seconds_per_bkt
 *  38      8     doubleBE  javaTime      (ms since Unix epoch)
 *  46      8     doubleBE  footage
 *  54      8     doubleBE  end_footage
 *  62      2     int16BE   bkt_cnt       (512 or 2048)
 *  64      4     int32BE   total_cnt
 *  68      4     int32BE   over_cnt
 *  72      4     int32BE   under_cnt
 *  76      8     doubleBE  avg
 *  84      4     floatBE   mini          (trend minimum)
 *  88      4     floatBE   maxi          (trend maximum)
 *  92      8     doubleBE  sum
 *  100     8     doubleBE  x2sum         (used to compute sigma)
 *  108     4     floatBE   strt_avg
 *  112     4     floatBE   end_avg
 *  116     2048  float[512] prf           (profile array, 512 floats * 4 bytes)
 *  2164    512   uint8[512] bkt_stat
 *  2676    4     floatBE   sheet_width
 *  2680    2     uint16BE  noDataFlag
 *  Total = 2682 bytes
 *
 * 2048-bucket mode: total = 4 + 10358 = 10362 bytes.
 *
 * Heartbeat: exactly 4 bytes, uint32LE value = 1789.
 */

/** Packet size constants */
const PACKET_SIZE_512  = 2682;   // ProNet, 512-bucket:  4 (gage) + 2678 (extProfByte_t)
const PACKET_SIZE_2048 = 10362;  // ProNet, 2048-bucket: 4 (gage) + 10358 (extProfByteBig_t)

/**
 * Non-ProNet (8000 dataserver) packet:
 *   4 bytes  gage number (little-endian uint32)
 *   10386 bytes raw scan_dat struct (little-endian, ARM GCC 32-bit layout)
 *
 * scan_dat field offsets (relative to start of scan_dat, i.e. byte 4 of packet):
 *   0   prev ptr      (4 bytes, ignored)
 *   4   next ptr      (4 bytes, ignored)
 *   8   data_type     (uint8)
 *   9   scan_dir      (uint8)
 *   10  status        (uint8)
 *   11  scanLoToHi    (uint8)
 *   12  rptd          (uint8)
 *   13  md_no         (uint8)
 *   14  [padding 2]
 *   16  min_scan      (double LE)
 *   24  max_scan      (double LE)
 *   32  bkt_wdth      (double LE)
 *   40  seconds_per_bkt (double LE)
 *   48  javaTime      (double LE)  ← ms since Unix epoch
 *   56  time_tag.hr   (uint8)
 *   57  time_tag.mn   (uint8)
 *   58  time_tag.sc   (uint8)
 *   59  [padding 5]
 *   64  footage       (double LE)
 *   72  end_footage   (double LE)
 *   80  bkt_cnt       (int16 LE)
 *   82  total_cnt     (int16 LE)
 *   84  over_cnt      (int16 LE)
 *   86  under_cnt     (int16 LE)
 *   88  ato_def_cnt   (int16 LE)
 *   90  [padding 2]
 *   92  avg           (double LE)
 *   100 mini          (float LE)   ← trend minimum
 *   104 maxi          (float LE)   ← trend maximum
 *   108 sum           (double LE)
 *   116 x2sum         (double LE)  ← for sigma
 *   124 strt_avg      (float LE)
 *   128 end_avg       (float LE)
 *   132 prf[2048]     (float[2048] LE, 8192 bytes)
 *   8324 bkt_stat[2048] (uint8[2048])
 *   10372 valid_apc_data (uint8)
 *   10373 [padding 3]
 *   10376 sheet_width  (float LE)
 *   10380 target       (float LE)
 *   10384 noDataFlag   (uint16 LE)
 *   Total: 10386 bytes
 *
 * Full packet = 4 + 10386 = 10390 bytes
 *
 * NOTE — stretchRatio field:
 *   structs.h defines `float stretchRatio` inside `#if MAX_STRETCHES > 0`.
 *   config.h sets NUM_SPEEDS=3, giving MAX_STRETCHES=2 > 0.
 *   If stretchRatio is compiled in, the layout becomes:
 *     10376 sheet_width  (float LE)
 *     10380 target       (float LE)
 *     10384 stretchRatio (float LE)  ← inserted before noDataFlag
 *     10388 noDataFlag   (uint16 LE)
 *     [2 bytes struct padding to align to 4-byte boundary]
 *     sizeof(scan_dat) = 10392  →  full packet = 10396 bytes
 *   Enable PRINT_OFFSETS in extobj.c to log the exact sizeof from the device.
 *   If you see persistent "unexpected byte sequence" warnings, increase
 *   SCAN_DAT_SIZE to 10392 and update the noDataFlag read offset below.
 */
const SCAN_DAT_SIZE      = 10386;
const PACKET_SIZE_NONPRONET = 4 + SCAN_DAT_SIZE; // 10390 bytes

/** Heartbeat value sent by device every ~10 seconds when no scan is occurring */
const HEARTBEAT_VALUE = 1789;

/**
 * Detects whether the given buffer is a heartbeat packet.
 * The device sends 1789 in two possible endian forms:
 *   - Non-ProNet mode: little-endian (NO_ENDSWAP) → bytes FD 06 00 00
 *   - ProNet mode:     big-endian    (ENDSWAP)    → bytes 00 00 06 FD
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isHeartbeat(buf) {
    if (buf.length !== 4) return false;
    return buf.readUInt32LE(0) === HEARTBEAT_VALUE || buf.readUInt32BE(0) === HEARTBEAT_VALUE;
}

/**
 * Reads the bkt_cnt field from a buffer that contains at least 64 bytes.
 * bkt_cnt is at byte offset 62, int16BE.
 *
 * @param {Buffer} buf  - buffer containing at least 64 bytes
 * @returns {number}    - 512 or 2048 (or other value if unexpected)
 */
function peekBktCnt(buf) {
    if (buf.length < 64) return 512; // not enough data yet, assume 512
    return buf.readInt16BE(62);
}

/**
 * Determines the expected full packet size based on bkt_cnt.
 *
 * @param {number} bktCnt
 * @returns {number}
 */
function expectedPacketSize(bktCnt) {
    return bktCnt === 2048 ? PACKET_SIZE_2048 : PACKET_SIZE_512;
}

/**
 * Parses a ProNet mode packet (big-endian, extProfByte_t body).
 * Packet layout: 4-byte gage# (BE) + 2678 or 10358 bytes (all BE fields).
 *
 * @param {Buffer} buf  - complete raw packet buffer (2682 or 10362 bytes)
 * @returns {Object}    - parsed scan data object
 */
function parseProNetPacket(buf) {
    // --- Fixed header fields ---
    const gageNumber      = buf.readUInt32BE(0);
    const dataType        = buf.readUInt8(4);
    const scanDir         = buf.readUInt8(5);
    const minScan         = buf.readDoubleBE(6);
    const maxScan         = buf.readDoubleBE(14);
    const bktWdth         = buf.readDoubleBE(22);
    const secondsPerBkt   = buf.readDoubleBE(30);
    const javaTime        = buf.readDoubleBE(38); // ms since Unix epoch
    const footage         = buf.readDoubleBE(46);
    const endFootage      = buf.readDoubleBE(54);
    const bktCnt          = buf.readInt16BE(62);
    const totalCnt        = buf.readInt32BE(64);
    const overCnt         = buf.readInt32BE(68);
    const underCnt        = buf.readInt32BE(72);
    const avg             = buf.readDoubleBE(76);
    const mini            = buf.readFloatBE(84);  // trend minimum
    const maxi            = buf.readFloatBE(88);  // trend maximum
    const sum             = buf.readDoubleBE(92);
    const x2sum           = buf.readDoubleBE(100);
    const strtAvg         = buf.readFloatBE(108);
    const endAvg          = buf.readFloatBE(112);

    // --- Profile array ---
    // prf[] starts at offset 116; count is bktCnt (512 or 2048); each float is big-endian
    const PRF_OFFSET_PRONET = 116;
    const prf = [];
    for (let i = 0; i < bktCnt; i++) {
        prf.push(buf.readFloatBE(PRF_OFFSET_PRONET + i * 4));
    }

    //console.log(prf.length)

    // --- Tail fields (after profile array) ---
    // For 512-bucket mode: prf starts at 116, occupies 2048 bytes, then 512 bytes bkt_stat
    // sheet_width at 2676, noDataFlag at 2680
    // For 2048-bucket mode the offsets shift; only read tail if buffer is 512-bucket size.
    let sheetWidth  = 0;
    let noDataFlag  = 0;

    if (buf.length >= PACKET_SIZE_512 && bktCnt !== 2048) {
        sheetWidth = buf.readFloatBE(2676);
        noDataFlag = buf.readUInt16BE(2680);
    }
    // In 2048-bucket mode we skip reading sheet_width / noDataFlag to avoid offset errors.
    // Extend this logic if those fields are needed in 2048-bucket mode.

    // --- Sigma computation ---
    // sigma = sqrt(|x2sum / total_cnt - avg^2|)
    // Guard against division by zero when total_cnt is 0.
    let sigma = 0;
    if (totalCnt > 0) {
        const variance = Math.abs(x2sum / totalCnt - avg * avg);
        sigma = Math.sqrt(variance);
    }

    return {
        type:         'scan',
        gage:         gageNumber,
        timestamp:    javaTime,        // ms since Unix epoch (Java time)
        dataType,
        scanDir,
        min:          mini,            // trend minimum
        max:          maxi,            // trend maximum
        avg,
        sigma,
        minScan,
        maxScan,
        // bktWdth,
        // secondsPerBkt,
        // footage,
        // endFootage,
        // bktCnt,
        // totalCnt,
        // overCnt,
        // underCnt,
        // sum,
        // x2sum,
        // strtAvg,
        // endAvg,
        // sheetWidth,
        noDataFlag,
        prf,   // cross-direction profile array, 512 floats
    };
}

/**
 * Parses a non-ProNet (8000 dataserver) packet.
 * Packet layout: 4-byte gage# (LE) + 10386-byte raw scan_dat struct (all LE fields).
 * Field offsets are relative to the START of the full packet (gage# included).
 *
 * @param {Buffer} buf  - complete raw packet buffer (10390 bytes)
 * @returns {Object}    - parsed scan data object
 */
function parseNonProNetPacket(buf) {
    // Gage number is at byte 0, little-endian
    const gageNumber = buf.readUInt32LE(0);

    // scan_dat fields — all offsets = struct_offset + 4 (gage header)
    const dataType      = buf.readUInt8(12);
    const scanDir       = buf.readUInt8(13);
    const minScan       = buf.readDoubleLE(20);
    const maxScan       = buf.readDoubleLE(28);
    const bktWdth       = buf.readDoubleLE(36);
    const secondsPerBkt = buf.readDoubleLE(44);
    const javaTime      = buf.readDoubleLE(52);  // ms since Unix epoch
    const timeHr        = buf.readUInt8(60);
    const timeMn        = buf.readUInt8(61);
    const timeSc        = buf.readUInt8(62);
    const footage       = buf.readDoubleLE(68);
    const endFootage    = buf.readDoubleLE(76);
    const bktCnt        = buf.readInt16LE(84);
    const totalCnt      = buf.readInt16LE(86);
    const overCnt       = buf.readInt16LE(88);
    const underCnt      = buf.readInt16LE(90);
    const avg           = buf.readDoubleLE(96);
    const mini          = buf.readFloatLE(104);  // trend minimum
    const maxi          = buf.readFloatLE(108);  // trend maximum
    const sum           = buf.readDoubleLE(112);
    const x2sum         = buf.readDoubleLE(120); // for sigma
    const strtAvg       = buf.readFloatLE(128);
    const endAvg        = buf.readFloatLE(132);

    // prf[512] — cross-direction profile, 512 floats starting immediately after endAvg
    const PRF_COUNT = 512;
    const PRF_OFFSET = 136; // packet offset = struct offset 132 + 4 (gage header)
    const prf = [];
    for (let i = 0; i < PRF_COUNT; i++) {
        prf.push(buf.readFloatLE(PRF_OFFSET + i * 4));
    }

    const sheetWidth    = buf.readFloatLE(10380);
    const target        = buf.readFloatLE(10384);
    const noDataFlag    = buf.readUInt16LE(10388);

    // Sigma: sqrt(|x2sum / totalCnt - avg^2|), guard against division by zero
    let sigma = 0;
    if (totalCnt > 0) {
        sigma = Math.sqrt(Math.abs(x2sum / totalCnt - avg * avg));
    }

    return {
        type:   'scan',
        mode:   'non-ProNet',
        gage:   gageNumber,
        timestamp: javaTime,        // ms since Unix epoch
        dataType,
        scanDir,
        min:    mini,               // trend minimum
        max:    maxi,               // trend maximum
        avg,
        sigma,
        minScan,
        maxScan,
        bktWdth,
        secondsPerBkt,
        timeTag: { hr: timeHr, mn: timeMn, sc: timeSc },
        footage,
        endFootage,
        bktCnt,
        totalCnt,
        overCnt,
        underCnt,
        sum,
        x2sum,
        strtAvg,
        endAvg,
        sheetWidth,
        target,
        noDataFlag,
        prf,   // cross-direction profile array, 512 floats
    };
}

module.exports = {
    PACKET_SIZE_512,
    PACKET_SIZE_2048,
    PACKET_SIZE_NONPRONET,
    SCAN_DAT_SIZE,
    isHeartbeat,
    peekBktCnt,
    expectedPacketSize,
    parseProNetPacket,
    parseNonProNetPacket,
};
