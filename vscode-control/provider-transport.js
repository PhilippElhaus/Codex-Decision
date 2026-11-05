"use strict";

const https = require("node:https");
const { Readable } = require("node:stream");

// Keep custom trust local to this request. The caller bounds the response
// stream and supplies the same deadline used by ordinary provider requests.
function certificateFetch(endpoint, options, certificate) {
  return new Promise((resolve, reject) => {
    const request = https.request(endpoint, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      ca: certificate,
      rejectUnauthorized: true,
      agent: false,
    }, response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new TypeError("Decision redirects are disabled"));
        return;
      }
      try {
        const empty = status === 204 || status === 205;
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response), { status }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

module.exports = { certificateFetch };
