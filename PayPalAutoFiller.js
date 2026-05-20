// ==UserScript==
// @name         PayPal Auto Filler
// @namespace    http://tampermonkey.net/
// @version      30.0
// @description  Auto-fill PayPal/OpenAI checkout pages
// @match        https://www.paypal.com/*
// @match        https://pay.openai.com/*
// @match        https://checkout.stripe.com/*
// @grant        GM_xmlhttpRequest
// @connect      meiguodizhi.com
// @run-at       document-idle
// ==/UserScript==

// ========== 配置 ==========
var CONFIG = {
  phone: "", // 电话号码
  cardNumber: "", // 卡号
  cardExpiry: "", // 有效期
  cardCvv: "", // CVV
};
// ========================

(function () {
  "use strict";
  var log = function (s) {
    console.log("[PP] " + s);
  };

  // 隐藏验证码和地址补全
  var st = document.createElement("style");
  st.textContent =
    "#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results{display:none!important;height:0!important;overflow:hidden!important}";
  document.head.appendChild(st);

  // 随机邮箱
  function randEmail() {
    var c = "abcdefghijklmnopqrstuvwxyz0123456789",
      e = "";
    for (var i = 0; i < 16; i++) e += c[Math.floor(Math.random() * c.length)];
    return e + "@gmail.com";
  }

  // 随机密码
  function randPass() {
    var L = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    var D = "0123456789",
      S = "!@#$%^",
      A = L + D + S;
    var p =
      L[Math.floor(Math.random() * 26)] +
      L[26 + Math.floor(Math.random() * 26)] +
      D[Math.floor(Math.random() * 10)] +
      S[Math.floor(Math.random() * 6)];
    for (var i = 4; i < 14; i++) p += A[Math.floor(Math.random() * A.length)];
    return p
      .split("")
      .sort(function () {
        return Math.random() - 0.5;
      })
      .join("");
  }

  // 填写input
  function fill(id, val) {
    var el = document.getElementById(id);
    if (!el) {
      log("NOT FOUND: " + id);
      return;
    }
    var ns = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    ns.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    log(id + " = " + el.value);
  }

  // 按选择器填写
  function fillSel(sel, val) {
    var el = document.querySelector(sel);
    if (!el) {
      log("NOT FOUND: " + sel);
      return;
    }
    var ns = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    ns.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    log(sel + " = " + el.value);
  }

  // 填写下拉框
  function fillSelect(id, text) {
    var el = document.getElementById(id);
    if (!el) {
      log("NOT FOUND: " + id);
      return;
    }
    for (var i = 0; i < el.options.length; i++) {
      if (
        el.options[i].text.toLowerCase().includes(text.toLowerCase()) ||
        el.options[i].value.toLowerCase().includes(text.toLowerCase())
      ) {
        el.value = el.options[i].value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        log(id + " = " + el.options[i].text);
        return;
      }
    }
  }

  // 从meiguodizhi.com API获取随机地址
  function getAddr(cb) {
    log("Fetching address from meiguodizhi.com API...");
    GM_xmlhttpRequest({
      method: "POST",
      url: "https://www.meiguodizhi.com/api/v1/dz",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ path: "/", method: "address" }),
      onload: function (r) {
        try {
          var d = JSON.parse(r.responseText);
          var a = d.address || d;
          var addr = {
            street: a.Address || a.street || "123 Main St",
            city: a.City || a.city || "New York",
            state: a.State_Full || a.State || a.state || "New York",
            zip: (a.Zip_Code || a.zip || "10001").substring(0, 5),
          };
          log("Address from API: " + JSON.stringify(addr));
          cb(addr);
        } catch (e) {
          log("Parse error: " + e.message);
          cb({
            street: "123 Main St",
            city: "New York",
            state: "New York",
            zip: "10001",
          });
        }
      },
      onerror: function (e) {
        log("Request failed: " + (e.statusText || "network error"));
        cb({
          street: "123 Main St",
          city: "New York",
          state: "New York",
          zip: "10001",
        });
      },
    });
  }

  // 点击按钮（带重试）
  function clickBtn(retries) {
    retries = retries || 0;
    var btn =
      document.querySelector('button[data-testid="submit-button"]') ||
      document.querySelector(
        'button[data-testid="hosted-payment-submit-button"]',
      ) ||
      document.querySelector(
        'button[data-atomic-wait-intent="Submit_Email"]',
      ) ||
      document.querySelector("button.SubmitButton--complete");
    if (!btn) {
      var all = document.querySelectorAll("button");
      for (var i = 0; i < all.length; i++) {
        var t = all[i].textContent.trim();
        if (
          t === "下一页" ||
          t === "Next" ||
          t === "Subscribe" ||
          t === "Pay" ||
          t === "Continue" ||
          t === "Agree"
        ) {
          btn = all[i];
          break;
        }
      }
    }
    if (btn) {
      if (btn.disabled) {
        log("Button disabled, waiting...");
        if (retries < 10)
          setTimeout(function () {
            clickBtn(retries + 1);
          }, 1000);
        return;
      }
      var rect = btn.getBoundingClientRect();
      log(
        "Button found: " +
          btn.textContent.trim() +
          " visible: " +
          (rect.height > 0),
      );
      if (rect.height === 0) {
        log("Button not visible, retrying...");
        if (retries < 10)
          setTimeout(function () {
            clickBtn(retries + 1);
          }, 1000);
        return;
      }
      log("Clicking: " + btn.textContent.trim());
      btn.click();
    } else {
      log("No button found, retrying... (" + retries + ")");
      if (retries < 10)
        setTimeout(function () {
          clickBtn(retries + 1);
        }, 1000);
    }
  }

  // ========== 主逻辑 ==========
  var host = window.location.host;
  var path = window.location.pathname;
  log("Host: " + host + " Path: " + path);

  // OpenAI/Stripe页面
  if (host.includes("pay.openai.com") || host.includes("checkout.stripe.com")) {
    log("=== OpenAI/Stripe Page ===");
    setTimeout(function () {
      var ppBtn =
        document.querySelector(
          '[data-testid="paypal-accordion-item-button"]',
        ) || document.querySelector(".paypal-accordion-item button");
      log("PayPal button found: " + !!ppBtn);
      if (ppBtn) {
        ppBtn.click();
        log("Clicked PayPal button");
        setTimeout(function () {
          ppBtn.click();
          log("Clicked PayPal button again");
        }, 500);
      } else {
        log(
          "PayPal button not found, all buttons: " +
            Array.from(document.querySelectorAll("button"))
              .map(function (b) {
                return b.textContent.trim().substring(0, 30);
              })
              .join(" | "),
        );
      }
      setTimeout(function () {
        getAddr(function (addr) {
          log("Address: " + JSON.stringify(addr));
          fillSel("#billingAddressLine1", addr.street);
          fillSel("#billingLocality", addr.city);
          fillSel("#billingPostalCode", addr.zip);
          fillSelect("billingAdministrativeArea", addr.state);
          var cb = document.getElementById("termsOfServiceConsentCheckbox");
          if (cb && !cb.checked) {
            cb.click();
            log("Checkbox checked");
          }
          setTimeout(clickBtn, 1000);
        });
      }, 3000);
    }, 2000);
    return;
  }

  // PayPal登录页 /pay
  if (host.includes("paypal.com") && path === "/pay") {
    log("=== PayPal Login Page ===");
    setTimeout(function () {
      var email = randEmail();
      log("Email: " + email);
      fill("email", email);
      setTimeout(clickBtn, 1000);
    }, 2000);
    return;
  }

  // PayPal结账页 /checkoutweb
  if (host.includes("paypal.com") && path.includes("/checkoutweb/")) {
    log("=== PayPal Checkout Page ===");
    setTimeout(function () {
      var country = document.getElementById("country");
      if (country && country.value !== "US") {
        country.value = "US";
        country.dispatchEvent(new Event("change", { bubbles: true }));
        log("Country -> US, waiting...");
        setTimeout(doFill, 3000);
      } else {
        doFill();
      }
    }, 2000);

    function doFill() {
      getAddr(function (addr) {
        var email = randEmail();
        var password = randPass();
        log("Email: " + email + " Pass: " + password);
        fill("email", email);
        fill("phone", CONFIG.phone);
        fill("cardNumber", CONFIG.cardNumber);
        fill("cardExpiry", CONFIG.cardExpiry);
        fill("cardCvv", CONFIG.cardCvv);
        fill("password", password);
        fill("firstName", "James");
        fill("lastName", "Smith");
        fill("billingLine1", addr.street);
        fill("billingCity", addr.city);
        fill("billingPostalCode", addr.zip);
        fillSelect("billingState", addr.state);
        setTimeout(clickBtn, 500);
      });
    }
    return;
  }

  log("Page not matched");
})();
