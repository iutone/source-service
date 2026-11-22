// Only media transforms run here. Session/key recovery and AES are native Swift:
// youkuDecryptECB(input, output) and youkuDecryptCBC(input, output, iv, crypt, skip) use the segment's key,
// which never enters this context. They mirror KuPlayer's packet filters (setDecryption) byte for byte.
(function () {
  "use strict";
  function ecb(packet) {
    var input = packet.data, output = new Uint8Array(input.length);
    if (!youkuDecryptECB(input, output)) throw new Error("AES-ECB failed");
    return output;
  }

  function cbc(packet) {
    var input = packet.data, scheme = packet.default_encryption, info = packet.encryptionInfo;
    if (!packet.encrypted || !scheme) return input;
    var output = new Uint8Array(input.length);
    if (!info || !info.subsample_count) {
      if (!youkuDecryptCBC(input, output, new Uint8Array(scheme.default_constant_IV), 0, 0)) throw new Error("AES-CBC failed");
      return output;
    }
    output.set(input);
    var iv = new Uint8Array(info.iv || scheme.default_constant_IV), offset = 0;
    for (var i = 0; i < info.subsample_count; i++) {
      offset += info.bytes_of_clear_data_list[i];
      var end = offset + info.bytes_of_protected_data_list[i];
      if (!youkuDecryptCBC(input.subarray(offset, end), output.subarray(offset, end), iv,
                           scheme.default_crypt_byte_block, scheme.default_skip_byte_block)) throw new Error("AES-CBC failed");
      offset = end;
    }
    return output;
  }

  globalThis.YoukuPrivateFilters = { ecb: ecb, cbc: cbc };

  globalThis.youkuRemux = function (input) {
    var mux = new YoukuMediaEngine.b();
    var types = YoukuMediaTypes;
    var cmaf = !!input.initialization;
    var type = cmaf ? (input.audio ? types.d.AUDIO : types.d.VIDEO) : types.d.MIXED;
    try {
      mux.init(type, cmaf ? types.a.MP4 : types.a.M2TS, [types.a.MP4]);
      mux.initAligner({ type: cmaf ? "fmp4" : "" });
      mux.setAligner({ type: type, timestampOffset: input.start, discontinuity: true, sequential: false });
      if (input.encrypted) mux.currentTransmuxer.demuxer.setPacketFilter(cmaf ? cbc : ecb);
      if (cmaf) mux.push(input.initialization);
      mux.push(input.media);
      mux.flush();
      var result = mux.getOutput({ fmp4: true, separate: false, type: type, forceAlign: !cmaf });
      if (!result || !result.data || !result.data[0] || result.data[0].length !== 2) throw new Error("Missing media output");
      var metadata = result.streams[0].metadata || {};
      return { initialization: result.data[0][0], media: result.data[0][1],
        width: metadata.width || 0, height: metadata.height || 0,
        codecs: result.streams.map(function (s) { return s.codecString; }).join(",") };
    } finally {
      mux.destroy();
    }
  };
})();
