/**
 * FUJIYAMA cart fulfillment — Доставка / Вземане от място, delivery
 * address (Google Maps pin-drop or plain form), chopsticks count, checkout gating.
 *
 * Ported from the sushibarmango cart-fulfillment module. Differences: the
 * Fujiyama drawer is client-rendered from /cart.js (no section morphing), so
 * this module reads state from cart.attributes on every `fuji:cart` event the
 * drawer dispatches, and paints the block itself.
 *
 * Cart attributes (they land on the order):
 *   Получаване · Адрес за доставка · Пощенски код · Координати · Клечки · Телефон
 * The phone is REQUIRED for every order (pickup too); checkout stays locked without it.
 */
(function () {
  'use strict';

  var LS_KEY = 'fujiyama_delivery_address';
  var MODE_DELIVERY = 'Доставка';
  var MODE_PICKUP = 'Вземане от място';
  var STICKS_ATTR = 'Клечки';
  var PHONE_ATTR = 'Телефон';

  var root = document.querySelector('[data-cf]');
  if (!root) return;

  var cfg = {
    mapsKey: root.dataset.mapsKey || '',
    storefrontToken: root.dataset.storefrontToken || '',
    center: { lat: parseFloat(root.dataset.centerLat) || 42.2059, lng: parseFloat(root.dataset.centerLng) || 24.3296 },
    pickupAddress: root.dataset.pickupAddress || ''
  };
  // Bias address search to the Пазарджик area
  var BOUNDS = { south: cfg.center.lat - 0.08, west: cfg.center.lng - 0.12, north: cfg.center.lat + 0.08, east: cfg.center.lng + 0.12 };

  var cart = null;       // last /cart.js payload
  var busy = false;
  var mapsLoading = null, map = null, marker = null, geocoder = null, resolved = null, searchTimer = null;

  /* ── state helpers ─────────────────────────────────── */

  function attrs() { return (cart && cart.attributes) || {}; }
  function mode() { return attrs()['Получаване'] === MODE_PICKUP ? MODE_PICKUP : MODE_DELIVERY; }
  function address() { return attrs()['Адрес за доставка'] || ''; }
  function zip() { return attrs()['Пощенски код'] || ''; }
  function sticks() { return String(attrs()[STICKS_ATTR] || ''); }
  function phone() { return String(attrs()[PHONE_ATTR] || ''); }
  // Bulgarian mobile/landline or international: 9–13 digits after stripping spaces, dashes, brackets.
  function normalizePhone(raw) {
    var v = String(raw || '').trim().replace(/[\s\-().]/g, '');
    if (!/^\+?\d{9,13}$/.test(v)) return '';
    return v;
  }

  function savedAddress() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }

  function tpl(id) {
    var t = document.getElementById(id);
    return t ? t.content.cloneNode(true) : document.createDocumentFragment();
  }

  function showError(sel, message) {
    var el = root.querySelector(sel);
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  /* ── cart update ───────────────────────────────────── */

  function updateCart(body) {
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('cart_update_failed');
      return r.json();
    }).then(function (data) {
      // refresh() re-renders the drawer and dispatches fuji:cart → paint()
      return window.FujiCart && window.FujiCart.refresh ? window.FujiCart.refresh().then(function () { return data; }) : data;
    });
  }

  /* ── Storefront API: preselect method + prefill address at checkout (optional) ── */

  function cartToken() {
    var m = document.cookie.match(/(?:^|;\s*)cart=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function syncBuyerIdentity(method, addr) {
    if (!cfg.storefrontToken) return Promise.resolve();
    var token = cartToken();
    if (!token) return Promise.resolve();
    var buyerIdentity = { countryCode: 'BG' };
    if (method) buyerIdentity.preferences = { delivery: { deliveryMethod: [method] } };
    if (addr && addr.address1) {
      buyerIdentity.deliveryAddressPreferences = [{ deliveryAddress: { address1: addr.address1, city: addr.city || 'Пазарджик', zip: addr.zip || '', country: 'Bulgaria' } }];
    }
    return fetch('/api/2025-07/graphql.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': cfg.storefrontToken },
      body: JSON.stringify({
        query: 'mutation cfBuyer($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) { cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) { userErrors { field message } } }',
        variables: { cartId: 'gid://shopify/Cart/' + token, buyerIdentity: buyerIdentity }
      })
    }).catch(function () { /* non-fatal: attributes still carry the address */ });
  }

  /* ── painting ──────────────────────────────────────── */

  function paintToggle(m) {
    root.querySelectorAll('[data-cf-mode]').forEach(function (b) {
      var active = b.dataset.cfMode === m;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-checked', String(active));
    });
  }

  function paintBody() {
    var body = root.querySelector('[data-cf-body]');
    if (!body) return;
    body.innerHTML = '';
    if (mode() === MODE_PICKUP) {
      var p = tpl('f-cf-tpl-pickup');
      var a = p.querySelector('[data-cf-pickup-address]');
      if (a) a.textContent = cfg.pickupAddress;
      body.appendChild(p);
    } else if (address()) {
      var t = tpl('f-cf-tpl-address');
      t.querySelector('[data-cf-address-text]').textContent = address() + (zip() ? ' · п.к. ' + zip() : '');
      body.appendChild(t);
    } else {
      var n = tpl('f-cf-tpl-noaddress');
      var label = n.querySelector('[data-cf-pick-label]');
      if (label && !cfg.mapsKey) label.textContent = 'Въведи адрес за доставка';
      body.appendChild(n);
    }
  }

  function paintSticks() {
    var value = sticks();
    root.querySelectorAll('[data-sticks-value]').forEach(function (b) {
      var active = b.dataset.sticksValue === value;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    var custom = root.querySelector('[data-sticks-custom]');
    if (custom) {
      var isCustom = Number(value) > 4;
      custom.classList.toggle('is-active', isCustom);
      if (isCustom) custom.value = value; else if (document.activeElement !== custom) custom.value = '';
    }
    var req = root.querySelector('[data-cf-sticks-req]');
    var hint = root.querySelector('[data-cf-sticks-hint]');
    var delivery = mode() === MODE_DELIVERY;
    if (req) req.hidden = !delivery;
    if (hint) hint.hidden = !(delivery && !value);
  }

  function paintPhone() {
    var input = root.querySelector('[data-cf-phone-input]');
    if (!input) return;
    if (document.activeElement !== input) input.value = phone();
    var ok = !!normalizePhone(phone());
    var hint = root.querySelector('[data-cf-phone-hint]');
    if (hint) hint.hidden = ok;
  }

  function blockedReason() {
    if (mode() === MODE_DELIVERY && !address()) return 'address';
    if (!normalizePhone(phone())) return 'phone';
    if (mode() === MODE_DELIVERY && !sticks()) return 'sticks';
    return '';
  }

  /* Save the phone as a cart attribute. Resolves true when a valid number is stored. */
  function savePhone(raw) {
    var input = root.querySelector('[data-cf-phone-input]');
    var v = normalizePhone(raw);
    if (!v) {
      if (input) input.classList.add('is-invalid');
      showError('[data-cf-phone-error]', 'Въведете валиден телефон, напр. 0888 123 456.');
      return Promise.resolve(false);
    }
    if (input) input.classList.remove('is-invalid');
    showError('[data-cf-phone-error]', '');
    if (v === phone()) return Promise.resolve(true);
    var attributes = {};
    attributes[PHONE_ATTR] = v;
    return updateCart({ attributes: attributes }).then(function () { return true; }).catch(function () {
      showError('[data-cf-phone-error]', 'Телефонът не се записа — опитайте отново.');
      return false;
    });
  }

  function paintCheckout() {
    var btn = document.querySelector('.f-cart-checkout');
    if (!btn) return;
    var reason = blockedReason();
    btn.classList.toggle('is-blocked', !!reason);
    btn.setAttribute('aria-disabled', reason ? 'true' : 'false');
    btn.dataset.cfBlocked = reason;
  }

  function paint() {
    root.hidden = !(cart && cart.item_count > 0);
    paintToggle(mode());
    paintBody();
    paintPhone();
    paintSticks();
    paintCheckout();
  }

  /* ── mode switching ────────────────────────────────── */

  function setMode(m) {
    if (busy || mode() === m) return;
    busy = true;
    paintToggle(m);
    root.setAttribute('aria-busy', 'true');
    showError('[data-cf-error]', '');
    var p;
    if (m === MODE_PICKUP) {
      p = updateCart({
        attributes: { 'Получаване': MODE_PICKUP, 'Адрес за доставка': '', 'Пощенски код': '', 'Координати': '' }
      }).then(function () {
        syncBuyerIdentity('PICK_UP', null);
      });
    } else {
      var saved = savedAddress();
      p = updateCart({
        attributes: {
          'Получаване': MODE_DELIVERY,
          'Адрес за доставка': saved ? saved.formatted : '',
          'Пощенски код': saved ? saved.zip : '',
          'Координати': saved && saved.lat ? saved.lat + ', ' + saved.lng : ''
        }
      }).then(function () {
        syncBuyerIdentity('SHIPPING', saved);
        if (!saved) openAddress();
      });
    }
    p.catch(function () {
      paintToggle(mode());
      showError('[data-cf-error]', 'Нещо се обърка — опитайте отново.');
    }).then(function () {
      busy = false;
      root.removeAttribute('aria-busy');
    });
  }

  /* ── chopsticks ────────────────────────────────────── */

  function setSticks(value) {
    if (busy) return;
    var n = parseInt(value, 10);
    if (!isFinite(n) || n < 1 || n > 99) { showError('[data-cf-sticks-error]', 'Въведете брой между 1 и 99.'); return; }
    busy = true;
    showError('[data-cf-sticks-error]', '');
    var attributes = {};
    attributes[STICKS_ATTR] = String(n);
    updateCart({ attributes: attributes }).catch(function () {
      showError('[data-cf-sticks-error]', 'Броят не се записа — опитайте отново.');
    }).then(function () { busy = false; });
  }

  /* ── address: plain form (no Maps key) ─────────────── */

  function openAddress() {
    if (cfg.mapsKey) { openMap(); return; }
    var body = root.querySelector('[data-cf-body]');
    if (!body || body.querySelector('[data-cf-form]')) return;
    body.innerHTML = '';
    var f = tpl('f-cf-tpl-form');
    var saved = savedAddress();
    if (saved) {
      f.querySelector('[name=address1]').value = saved.address1 || '';
      f.querySelector('[name=city]').value = saved.city || 'Пазарджик';
      f.querySelector('[name=zip]').value = saved.zip || '4400';
    }
    body.appendChild(f);
    var first = body.querySelector('[name=address1]');
    if (first) first.focus();
  }

  var formCoords = null; // set by "Използвай моето местоположение" in the plain form

  function saveForm(form) {
    var address1 = form.address1.value.trim(), city = form.city.value.trim() || 'Пазарджик', zipv = form.zip.value.trim();
    if (address1.length < 4) { showError('[data-cf-error]', 'Въведете улица и номер.'); return; }
    var coords = formCoords && formCoords.address1 === address1 ? formCoords : null;
    resolved = { formatted: address1 + ', ' + city, address1: address1, city: city, zip: zipv, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null };
    confirmAddress();
  }

  /* Plain form: fill the fields from the device location (OpenStreetMap reverse geocoding — no key needed). */
  function geoFillForm(button) {
    var form = button.closest('[data-cf-form]');
    var status = form && form.querySelector('[data-cf-geo-status]');
    var say = function (msg) { if (status) { status.textContent = msg; status.hidden = !msg; } };
    if (!navigator.geolocation) { say('Браузърът не поддържа локация — въведете адреса ръчно.'); return; }
    button.setAttribute('aria-busy', 'true');
    say('Определяме местоположението…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = +pos.coords.latitude.toFixed(6), lng = +pos.coords.longitude.toFixed(6);
      fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=bg&lat=' + lat + '&lon=' + lng, { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var a = (data && data.address) || {};
          var street = [a.road || a.pedestrian || a.residential || '', a.house_number || ''].filter(Boolean).join(' ');
          if (!street && data && data.display_name) street = data.display_name.split(',').slice(0, 2).join(',').trim();
          form.address1.value = street;
          form.city.value = a.city || a.town || a.village || a.municipality || form.city.value || 'Пазарджик';
          if (a.postcode) form.zip.value = a.postcode;
          formCoords = { address1: street, lat: lat, lng: lng };
          say(street ? 'Адресът е попълнен от местоположението ви — проверете номера и входа.' : 'Местоположението е записано — допълнете улицата и номера.');
          if (!street) formCoords.address1 = '';
          form.address1.focus();
        })
        .catch(function () {
          formCoords = { address1: '', lat: lat, lng: lng };
          say('Местоположението е записано (' + lat + ', ' + lng + ') — въведете адреса ръчно.');
        })
        .then(function () { button.removeAttribute('aria-busy'); });
    }, function (err) {
      button.removeAttribute('aria-busy');
      say(err && err.code === 1 ? 'Достъпът до местоположението е отказан — разрешете го в браузъра или въведете адреса ръчно.' : 'Местоположението не може да се определи — въведете адреса ръчно.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  /* ── Google Maps pin-drop ──────────────────────────── */

  function loadMaps() {
    if (window.google && window.google.maps) return Promise.resolve();
    if (mapsLoading) return mapsLoading;
    mapsLoading = new Promise(function (resolve, reject) {
      window.__fcfMapsReady = resolve;
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.mapsKey) + '&language=bg&region=BG&callback=__fcfMapsReady';
      s.async = true;
      s.onerror = function () { reject(new Error('maps_load_failed')); };
      document.head.appendChild(s);
    });
    return mapsLoading;
  }

  function dialog() { return document.getElementById('f-cf-map'); }

  function openMap() {
    var dlg = dialog();
    if (!dlg) return;
    if (dlg.parentElement !== document.body) document.body.appendChild(dlg); // above the drawer's stacking context
    dlg.showModal();
    loadMaps().then(function () {
      var saved = savedAddress();
      var start = saved && saved.lat ? { lat: saved.lat, lng: saved.lng } : cfg.center;
      var canvas = dlg.querySelector('#f-cf-map-canvas');
      if (!map || !canvas.contains(map.getDiv())) {
        var loading = canvas.querySelector('.f-cf-map-loading');
        if (loading) loading.remove();
        map = new google.maps.Map(canvas, { center: start, zoom: saved && saved.lat ? 17 : 13, disableDefaultUI: true, zoomControl: true, clickableIcons: false });
        geocoder = new google.maps.Geocoder();
        marker = new google.maps.Marker({ map: map, position: start, draggable: true, title: 'Вашият адрес' });
        marker.addListener('dragend', function () { resolvePosition(marker.getPosition()); });
        map.addListener('click', function (e) { marker.setPosition(e.latLng); resolvePosition(e.latLng); });
      } else {
        map.setCenter(start); map.setZoom(saved && saved.lat ? 17 : 13); marker.setPosition(start);
      }
      if (saved && saved.lat) { resolved = saved; renderResolved(); }
    }).catch(function () {
      var loading = dlg.querySelector('.f-cf-map-loading');
      if (loading) loading.textContent = 'Картата не можа да се зареди. Проверете Google Maps ключа в настройките на темата.';
    });
  }

  function onSearchInput(input) {
    clearTimeout(searchTimer);
    var q = input.value.trim();
    if (q.length < 3) { renderSuggestions([]); return; }
    searchTimer = setTimeout(function () {
      if (!geocoder) return;
      geocoder.geocode({ address: q, region: 'bg', componentRestrictions: { country: 'BG' }, bounds: BOUNDS }, function (results, status) {
        renderSuggestions(status === 'OK' && results ? results.slice(0, 5) : []);
      });
    }, 350);
  }

  function renderSuggestions(results) {
    var list = dialog() && dialog().querySelector('[data-cf-suggestions]');
    if (!list) return;
    list.innerHTML = '';
    list.hidden = results.length === 0;
    results.forEach(function (result) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'f-cf-map-suggestion';
      btn.textContent = result.formatted_address;
      btn.addEventListener('click', function () {
        list.hidden = true;
        var loc = result.geometry.location;
        map.panTo(loc); map.setZoom(17); marker.setPosition(loc);
        applyGeocode(result, loc);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function resolvePosition(latLng) {
    if (!geocoder) return;
    geocoder.geocode({ location: latLng }, function (results, status) {
      if (status === 'OK' && results && results[0]) applyGeocode(results[0], latLng);
    });
  }

  function applyGeocode(result, latLng) {
    var parts = {};
    (result.address_components || []).forEach(function (c) { c.types.forEach(function (t) { parts[t] = c.long_name; }); });
    var street = [parts.route, parts.street_number].filter(Boolean).join(' ');
    var lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
    var lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
    resolved = {
      formatted: result.formatted_address || street,
      address1: street || result.formatted_address || '',
      city: parts.locality || parts.postal_town || parts.administrative_area_level_1 || 'Пазарджик',
      zip: parts.postal_code || '',
      lat: +lat.toFixed(6), lng: +lng.toFixed(6)
    };
    renderResolved();
  }

  function renderResolved() {
    var dlg = dialog();
    if (!dlg || !resolved) return;
    var box = dlg.querySelector('[data-cf-resolved]'), text = dlg.querySelector('[data-cf-resolved-text]'), confirm = dlg.querySelector('[data-cf-confirm]');
    box.hidden = false;
    text.textContent = resolved.zip ? resolved.formatted + ' · п.к. ' + resolved.zip : resolved.formatted + ' (без пощенски код — преместете пина по-точно)';
    confirm.disabled = false;
  }

  function locateMe() {
    if (!navigator.geolocation || !map || !marker) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      var loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      map.panTo(loc); map.setZoom(17); marker.setPosition(loc);
      resolvePosition(new google.maps.LatLng(loc));
    });
  }

  function confirmAddress() {
    if (!resolved || busy) return;
    busy = true;
    try { localStorage.setItem(LS_KEY, JSON.stringify(resolved)); } catch (e) {}
    updateCart({
      attributes: {
        'Получаване': MODE_DELIVERY,
        'Адрес за доставка': resolved.formatted,
        'Пощенски код': resolved.zip || '',
        'Координати': resolved.lat ? resolved.lat + ', ' + resolved.lng : ''
      }
    }).then(function () {
      syncBuyerIdentity('SHIPPING', resolved);
      var dlg = dialog();
      if (dlg && dlg.open) dlg.close();
    }).catch(function () {
      showError('[data-cf-error]', 'Адресът не се записа — опитайте отново.');
    }).then(function () { busy = false; });
  }

  /* ── wiring ────────────────────────────────────────── */

  document.addEventListener('fuji:cart', function (e) {
    cart = e.detail;
    paint();
  });

  document.addEventListener('click', function (e) {
    var modeBtn = e.target.closest('[data-cf-mode]');
    if (modeBtn) { e.preventDefault(); setMode(modeBtn.dataset.cfMode); return; }
    if (e.target.closest('[data-cf-open-address]')) { e.preventDefault(); openAddress(); return; }
    if (e.target.closest('[data-cf-form-cancel]')) { e.preventDefault(); paintBody(); return; }
    var geo = e.target.closest('[data-cf-form-geo]');
    if (geo) { e.preventDefault(); geoFillForm(geo); return; }
    if (e.target.closest('[data-cf-map-close]')) { var d = dialog(); if (d && d.open) d.close(); return; }
    if (e.target.closest('[data-cf-confirm]')) { confirmAddress(); return; }
    if (e.target.closest('[data-cf-locate]')) { locateMe(); return; }
    var stick = e.target.closest('[data-sticks-value]');
    if (stick) { e.preventDefault(); setSticks(stick.dataset.sticksValue); return; }

    var checkout = e.target.closest('.f-cart-checkout');
    if (checkout) {
      var reason = blockedReason();
      if (reason === 'phone') {
        // The number may be typed but not saved yet (no blur): save it, then go on.
        e.preventDefault();
        var phoneInput = root.querySelector('[data-cf-phone-input]');
        savePhone(phoneInput ? phoneInput.value : '').then(function (ok) {
          if (ok && !blockedReason()) { checkout.click(); return; }
          if (!ok && phoneInput) {
            if (phoneInput.scrollIntoView) phoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            phoneInput.focus({ preventScroll: true });
          } else if (ok) { checkout.click(); }
        });
        return;
      }
      if (reason) {
        e.preventDefault();
        if (reason === 'sticks') {
          showError('[data-cf-sticks-error]', 'Моля, изберете брой клечки/прибори преди поръчка.');
          var box = root.querySelector('[data-cf-sticks]');
          if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          openAddress();
        }
        return;
      }
      if (cfg.storefrontToken) {
        // Sync method + address to the cart, then continue (2.5 s cap so checkout never hangs)
        e.preventDefault();
        var pickup = mode() === MODE_PICKUP;
        Promise.race([syncBuyerIdentity(pickup ? 'PICK_UP' : 'SHIPPING', pickup ? null : savedAddress()), new Promise(function (r) { setTimeout(r, 2500); })])
          .then(function () { window.location.assign('/checkout'); });
      }
    }
  }, true);

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.matches('[data-cf-form]')) { e.preventDefault(); saveForm(e.target); }
  });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'f-cf-map-search') onSearchInput(e.target);
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.matches && e.target.matches('[data-sticks-custom]') && e.target.value !== '') setSticks(e.target.value);
    if (e.target && e.target.matches && e.target.matches('[data-cf-phone-input]') && e.target.value !== '') savePhone(e.target.value);
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.matches && e.target.matches('[data-cf-phone-input]') && e.key === 'Enter') { e.preventDefault(); savePhone(e.target.value); }
    if (e.target && e.target.id === 'f-cf-map-search' && e.key === 'Enter') e.preventDefault();
  });

  // If the drawer already loaded the cart before this module ran, paint from it.
  if (window.FujiCart && window.FujiCart.cart) { cart = window.FujiCart.cart; paint(); }
})();
