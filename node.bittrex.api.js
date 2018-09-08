import request from 'request';
import assign from 'object-assign';
import jsonic from 'jsonic';
import signalR from 'signalr-client';
import cloudscraper from 'cloudscraper';
import hmac_sha512 from './hmac-sha512';

function NodeBittrexApi(instanceOptions) {
  let wsclient = null;

  const default_request_options = {
    method: 'GET',
    agent: false,
    headers: {
      'User-Agent': 'Mozilla/4.0 (compatible; Node Bittrex API)',
      'Content-type': 'application/x-www-form-urlencoded',
    },
  };

  const opts = {
    baseUrl: 'https://bittrex.com/api/v1.1',
    baseUrlv2: 'https://bittrex.com/Api/v2.0',
    websockets_baseurl: 'wss://socket.bittrex.com/signalr',
    websockets_hubs: ['CoreHub'],
    apikey: 'APIKEY',
    apisecret: 'APISECRET',
    verbose: false,
    cleartext: false,
    inverse_callback_arguments: false,
    websockets: {
      autoReconnect: true,
    },
    requestTimeoutInSeconds: 15,
  };

  const extractOptions = function (options) {
    Object.keys(options).forEach((obj) => {
      opts[obj] = options[obj];
    });
  };

  if (instanceOptions) {
    extractOptions(instanceOptions);
  }

  let lastNonces = [];
  const getNonce = function () {
    let nonce = new Date().getTime();

    while (lastNonces.indexOf(nonce) > -1) {
      nonce = new Date().getTime(); // Repetition of the above. This can probably done better :-)
    }

    // keep the last X to try ensure we don't have collisions even if the clock is adjusted
    lastNonces = lastNonces.slice(-50);

    lastNonces.push(nonce);

    return nonce;
  };

  const updateQueryStringParameter = function (uri, key, value) {
    const re = new RegExp(`([?&])${key}=.*?(&|$)`, 'i');
    const separator = uri.indexOf('?') !== -1 ? '&' : '?';

    if (uri.match(re)) {
      return uri.replace(re, `$1${key}=${value}$2`);
    }
    return `${uri + separator + key}=${value}`;
  };

  const setRequestUriGetParams = function (uri, options) {
    let op;
    let params = '';
    if (typeof (uri) === 'object') {
      op = uri;
      params = op.uri;
    } else {
      op = assign({}, default_request_options);
    }

    Object.keys(options).forEach((obj) => {
      params = updateQueryStringParameter(uri, obj, options[obj]);
    });

    op.headers.apisign = hmac_sha512.HmacSHA512(params || uri, opts.apisecret); // setting the HMAC hash `apisign` http header
    op.uri = params || uri;
    op.timeout = opts.requestTimeoutInSeconds * 1000;

    return op;
  };

  const apiCredentials = function (uri) {
    const options = {
      apikey: opts.apikey,
      nonce: getNonce(),
    };
    return setRequestUriGetParams(uri, options);
  };


  const sendRequestCallback = function (callback, op) {
    const start = Date.now();

    request(op, (error, result, body) => {
      ((opts.verbose) ? console.log(`requested from ${op.uri} in: %ds`, (Date.now() - start) / 1000) : '');
      if (!body || !result || result.statusCode !== 200) {
        const errorObj = {
          success: false,
          message: 'URL request error',
          error,
          result,
        };
        ((opts.inverse_callback_arguments) ?
          callback(errorObj, null) :
          callback(null, errorObj));
        return;
      }
      try {
        const jsonResult = JSON.parse(body);
        if (!result || !result.success) {
          // error returned by bittrex API - forward the result as an error
          ((opts.inverse_callback_arguments) ?
            callback(result, null) :
            callback(null, result));
          return;
        }
        ((opts.inverse_callback_arguments) ?
          callback(null, ((opts.cleartext) ? body : jsonResult)) :
          callback(((opts.cleartext) ? body : jsonResult), null));
        return;
      } catch (err) {
        console.error(err);
      }
    });
  };

  const publicApiCall = function (url, callback, options) {
    const op = assign({}, default_request_options);
    if (!options) {
      op.uri = url;
    }
    sendRequestCallback(callback, (!options) ? op : setRequestUriGetParams(url, options));
  };

  const credentialApiCall = function (url, callback, options) {
    if (options) {
      options = setRequestUriGetParams(apiCredentials(url), options);
    }
    sendRequestCallback(callback, options);
  };

  let websocketGlobalTickers = false;
  let websocketGlobalTickerCallback;
  let websocketMarkets = [];
  let websocketMarketsCallbacks = [];
  let websocketLastMessage = (new Date()).getTime();
  let websocketWatchDog;

  const resetWs = function () {
    websocketGlobalTickers = false;
    websocketGlobalTickerCallback = undefined;
    websocketMarkets = [];
    websocketMarketsCallbacks = [];
  };

  const connectws = function (callback, force) {
    if (wsclient && !force && callback) {
      return callback(wsclient);
    }

    if (force) {
      try {
        wsclient.end();
      } catch (e) {
        console.error(e);
      }
    }

    if (!websocketWatchDog) {
      websocketWatchDog = setInterval(() => {
        if (!wsclient) {
          return;
        }

        if (
          opts.websockets &&
          (
            opts.websockets.autoReconnect === true ||
            typeof (opts.websockets.autoReconnect) === 'undefined'
          )
        ) {
          const now = (new Date()).getTime();
          const diff = now - websocketLastMessage;

          if (diff > 60 * 1000) {
            ((opts.verbose) ? console.log('Websocket Watch Dog: Websocket has not received communication for over 1 minute. Forcing reconnection. Ruff!') : '');
            connectws(callback, true);
          } else {
            ((opts.verbose) ? console.log(`Websocket Watch Dog: Last message received ${diff}ms ago. Ruff!`) : '');
          }
        }
      }, 5 * 1000);
    }

    cloudscraper.get('https://bittrex.com/', (error, response) => {
      if (error) {
        console.error('Cloudscraper error occurred');
        console.error(error);
        return;
      }

      opts.headers = {
        cookie: (response.request.headers.cookie || ''),
        user_agent: (response.request.headers['User-Agent'] || ''),
      };

      wsclient = new signalR.client(
        opts.websockets_baseurl,
        opts.websockets_hubs,
        undefined,
        true,
      );

      if (opts.headers) {
        wsclient.headers['User-Agent'] = opts.headers.user_agent;
        wsclient.headers.cookie = opts.headers.cookie;
      }

      wsclient.start();
      wsclient.serviceHandlers = {
        bound() {
          ((opts.verbose) ? console.log('Websocket bound') : '');
          if (opts.websockets && typeof (opts.websockets.onConnect) === 'function') {
            resetWs();
            opts.websockets.onConnect();
          }
        },
        connectFailed(err) {
          ((opts.verbose) ? console.log('Websocket connectFailed: ', err) : '');
        },
        disconnected() {
          ((opts.verbose) ? console.log('Websocket disconnected') : '');
          if (opts.websockets && typeof (opts.websockets.onDisconnect) === 'function') {
            opts.websockets.onDisconnect();
          }

          if (
            opts.websockets &&
            (
              opts.websockets.autoReconnect === true ||
              typeof (opts.websockets.autoReconnect) === 'undefined'
            )
          ) {
            ((opts.verbose) ? console.log('Websocket auto reconnecting.') : '');
            wsclient.start(); // ensure we try reconnect
          } else if (websocketWatchDog) {
            clearInterval(websocketWatchDog);
            websocketWatchDog = null;
          }
        },
        onerror(err) {
          ((opts.verbose) ? console.log('Websocket onerror: ', err) : '');
        },
        bindingError(err) {
          ((opts.verbose) ? console.log('Websocket bindingError: ', err) : '');
        },
        connectionLost(err) {
          ((opts.verbose) ? console.log('Connection Lost: ', err) : '');
        },
        reconnecting() {
          return true;
        },
        connected() {
          if (websocketGlobalTickers) {
            wsclient.call('CoreHub', 'SubscribeToSummaryDeltas').done((err, result) => {
              if (err) {
                console.error(err);
                return;
              }

              if (result === true) {
                ((opts.verbose) ? console.log('Subscribed to global tickers') : '');
              }
            });
          }

          if (websocketMarkets.length > 0) {
            websocketMarkets.forEach((market) => {
              wsclient.call('CoreHub', 'SubscribeToExchangeDeltas', market).done((err, result) => {
                if (err) {
                  console.error(err);
                  return;
                }

                if (result === true) {
                  ((opts.verbose) ? console.log(`Subscribed to ${market}`) : '');
                }
              });
            });
          }
          ((opts.verbose) ? console.log('Websocket connected') : '');
        },
      };

      if (callback) {
        callback(wsclient);
      }
    }, opts.cloudscraper_headers || {});

    return wsclient;
  };

  const setMessageReceivedWs = function () {
    wsclient.serviceHandlers.messageReceived = function (message) {
      websocketLastMessage = (new Date()).getTime();
      try {
        const data = jsonic(message.utf8Data);
        if (data && data.M) {
          data.M.forEach((M) => {
            if (websocketGlobalTickerCallback) {
              websocketGlobalTickerCallback(M, wsclient);
            }
            if (websocketMarketsCallbacks.length > 0) {
              websocketMarketsCallbacks.forEach((callback) => {
                callback(M, wsclient);
              });
            }
          });
        } else {
          // ((opts.verbose) ? console.log('Unhandled data', data) : '');
          if (websocketGlobalTickerCallback) {
            websocketGlobalTickerCallback({ unhandled_data: data }, wsclient);
          }
          if (websocketMarketsCallbacks.length > 0) {
            websocketMarketsCallbacks.forEach((callback) => {
              callback({ unhandled_data: data }, wsclient);
            });
          }
        }
      } catch (e) {
        ((opts.verbose) ? console.error(e) : '');
      }
      return false;
    };
  };

  return {
    options(options) {
      extractOptions(options);
    },
    websockets: {
      client(callback, force) {
        return connectws(callback, force);
      },
      listen(callback, force) {
        connectws(() => {
          websocketGlobalTickers = true;
          websocketGlobalTickerCallback = callback;
          setMessageReceivedWs();
        }, force);
      },
      subscribe(markets, callback, force) {
        connectws(() => {
          websocketMarkets = websocketMarkets.concat(markets);
          websocketMarketsCallbacks.push(callback);
          setMessageReceivedWs();
        }, force);
      },
    },
    sendCustomRequest(request_string, callback, credentials) {
      let op;

      if (credentials === true) {
        op = apiCredentials(request_string);
      } else {
        op = assign({}, default_request_options, { uri: request_string });
      }
      sendRequestCallback(callback, op);
    },
    getmarkets(callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarkets`, callback, null);
    },
    getcurrencies(callback) {
      publicApiCall(`${opts.baseUrl}/public/getcurrencies`, callback, null);
    },
    getticker(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getticker`, callback, options);
    },
    getmarketsummaries(callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarketsummaries`, callback, null);
    },
    getmarketsummary(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarketsummary`, callback, options);
    },
    getorderbook(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getorderbook`, callback, options);
    },
    getmarkethistory(options, callback) {
      publicApiCall(`${opts.baseUrl}/public/getmarkethistory`, callback, options);
    },
    getcandles(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetTicks`, callback, options);
    },
    getticks(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetTicks`, callback, options);
    },
    getlatesttick(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/market/GetLatestTick`, callback, options);
    },
    buylimit(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/buylimit`, callback, options);
    },
    buymarket(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/buymarket`, callback, options);
    },
    selllimit(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/selllimit`, callback, options);
    },
    tradesell(options, callback) {
      credentialApiCall(`${opts.baseUrlv2}/key/market/TradeSell`, callback, options);
    },
    tradebuy(options, callback) {
      credentialApiCall(`${opts.baseUrlv2}/key/market/TradeBuy`, callback, options);
    },
    sellmarket(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/sellmarket`, callback, options);
    },
    cancel(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/cancel`, callback, options);
    },
    getopenorders(options, callback) {
      credentialApiCall(`${opts.baseUrl}/market/getopenorders`, callback, options);
    },
    getbalances(callback) {
      credentialApiCall(`${opts.baseUrl}/account/getbalances`, callback, {});
    },
    getbalance(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getbalance`, callback, options);
    },
    getwithdrawalhistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getwithdrawalhistory`, callback, options);
    },
    getdepositaddress(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getdepositaddress`, callback, options);
    },
    getdeposithistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getdeposithistory`, callback, options);
    },
    getorderhistory(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getorderhistory`, callback, options || {});
    },
    getorder(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/getorder`, callback, options);
    },
    withdraw(options, callback) {
      credentialApiCall(`${opts.baseUrl}/account/withdraw`, callback, options);
    },
    getbtcprice(options, callback) {
      publicApiCall(`${opts.baseUrlv2}/pub/currencies/GetBTCPrice`, callback, options);
    },
  };
}

export default NodeBittrexApi;
module.exports.createInstance = NodeBittrexApi;
