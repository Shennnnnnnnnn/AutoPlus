export const COMMON_PAGE_HELPERS = String.raw`
(() => {
  if (window.__AUTOPLUS_HELPERS__) return;
  window.__AUTOPLUS_HELPERS__ = true;
  window.AutoPlus = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    text: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    visible(el) {
      if (!el) return false;
      let node = el;
      while (node && node.nodeType === 1) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        node = node.parentElement;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    fill(el, value) {
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, String(value || ''));
      else el.value = String(value || '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    },
    fillId(id, value) {
      return this.fill(document.getElementById(id), value);
    },
    fillSel(selector, value) {
      return this.fill(document.querySelector(selector), value);
    },
    selectByText(id, text) {
      const select = document.getElementById(id);
      const expected = this.text(text).toLowerCase();
      if (!select || !expected) return false;
      const option = Array.from(select.options || []).find((item) => {
        return this.text(item.textContent || item.label).toLowerCase().includes(expected)
          || this.text(item.value).toLowerCase().includes(expected);
      });
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    click(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', eventInit)); } catch {}
      el.dispatchEvent(new MouseEvent('mousedown', eventInit));
      try { el.dispatchEvent(new PointerEvent('pointerup', eventInit)); } catch {}
      el.dispatchEvent(new MouseEvent('mouseup', eventInit));
      el.dispatchEvent(new MouseEvent('click', eventInit));
      return true;
    },
    actionText(el) {
      return this.text([el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('placeholder'), el?.name, el?.id].filter(Boolean).join(' '));
    },
    findButton(patterns) {
      const list = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter((el) => this.visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      return list.find((el) => patterns.some((pattern) => pattern.test(this.actionText(el)))) || null;
    },
    hideNoise() {
      const style = document.getElementById('autoplus-hide-style') || document.createElement('style');
      style.id = 'autoplus-hide-style';
      style.textContent = '#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results,[class*="AddressAutocomplete"]{display:none!important;visibility:hidden!important;pointer-events:none!important;height:0!important;overflow:hidden!important}';
      document.head.appendChild(style);
      document.querySelectorAll('#captcha-standalone,.captcha-overlay,.captcha-container').forEach((node) => node.remove());
    },
    state() {
      const host = location.host;
      const path = location.pathname;
      const verificationInputs = Array.from({ length: 6 }, (_, index) => document.getElementById('ci-ciBasic-' + index)).filter((el) => this.visible(el));
      const datadomeCaptcha = document.querySelector([
        '#ddv1-captcha-container',
        '[data-dd-ddv1-captcha-container]',
        '#captcha__frame',
        'iframe[title*="DataDome" i]',
        'iframe[src*="geo.ddc.paypal.com/captcha"]',
        'iframe[src*="ct.ddc.paypal.com/captcha"]',
        'iframe[src*="ddc.paypal.com/captcha"]',
      ].join(', '));
      const genericCaptcha = document.querySelector('#captcha-standalone, .captcha-overlay, .captcha-container');
      const visibleCaptcha = [datadomeCaptcha, genericCaptcha].some((el) => this.visible(el));
      return {
        url: location.href,
        host,
        path,
        isOpenAiCheckout: /pay\.openai\.com|checkout\.stripe\.com|chatgpt\.com\/checkout/i.test(location.href),
        isPayPal: /paypal\./i.test(host),
        isPayPalLogin: /paypal\./i.test(host) && (path === '/pay' || !!document.getElementById('email')),
        isPayPalGuest: /paypal\./i.test(host) && (/\/checkoutweb\//i.test(path) || !!document.getElementById('cardNumber') || !!document.getElementById('billingLine1')),
        isPayPalReview: /paypal\./i.test(host) && /\/webapps\/hermes/i.test(path),
        verificationInputs: verificationInputs.length,
        hasCaptcha: visibleCaptcha,
        captchaKind: datadomeCaptcha && this.visible(datadomeCaptcha) ? 'datadome' : visibleCaptcha ? 'generic' : '',
        success: /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com)\/(?:backend-api\/)?payments\/success(?:[/?#]|$)/i.test(location.href),
      };
    }
  };
})();
`;

export function openAiCheckoutStepExpression(addressJson) {
  return String.raw`
(async () => {
  // autoplus-action: openai-checkout
  ${COMMON_PAGE_HELPERS}
  const A = window.AutoPlus;
  A.hideNoise();
  await A.sleep(1500);
  const pp = document.querySelector('[data-testid="paypal-accordion-item-button"]') || document.querySelector('.paypal-accordion-item button');
  if (pp) { A.click(pp); await A.sleep(500); A.click(pp); }
  await A.sleep(2500);
  const address = ${addressJson};
  A.fillSel('#billingAddressLine1', address.street || '');
  A.fillSel('#billingLocality', address.city || '');
  A.fillSel('#billingPostalCode', address.zip || '');
  A.selectByText('billingAdministrativeArea', address.state || '');
  const checkbox = document.getElementById('termsOfServiceConsentCheckbox');
  if (checkbox && !checkbox.checked) A.click(checkbox);
  document.activeElement?.blur?.();
  await A.sleep(2500);
  const button = document.querySelector('button[data-testid="submit-button"]')
    || document.querySelector('button[data-testid="hosted-payment-submit-button"]')
    || document.querySelector('button[data-atomic-wait-intent="Submit_Email"]')
    || document.querySelector('button.SubmitButton--complete')
    || A.findButton([/next|pay|continue|agree|subscribe/i, /下一页|下一步|支付|继续|同意|订阅/i]);
  if (!button) return { clicked: false, reason: 'submit-not-found', state: A.state() };
  if (!button.disabled) A.click(button);
  await A.sleep(1000);
  A.hideNoise();
  return { clicked: true, state: A.state() };
})()
`;
}

export function fillVerificationExpression(code) {
  return String.raw`
(() => {
  ${COMMON_PAGE_HELPERS}
  const A = window.AutoPlus;
  const code = ${JSON.stringify(code)};
  for (let index = 0; index < 6; index += 1) A.fillId('ci-ciBasic-' + index, code[index] || '');
  return { filled: true, state: A.state() };
})()
`;
}

export function captchaPromptExpression(message) {
  return String.raw`
(() => {
  // autoplus-action: captcha-prompt
  ${COMMON_PAGE_HELPERS}
  const text = ${JSON.stringify(message)};
  const existing = document.getElementById('autoplus-captcha-prompt');
  if (existing) return { shown: false, state: window.AutoPlus.state() };
  const box = document.createElement('div');
  box.id = 'autoplus-captcha-prompt';
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'top:24px',
    'transform:translateX(-50%)',
    'max-width:520px',
    'padding:14px 18px',
    'border-radius:8px',
    'background:#111827',
    'color:#fff',
    'font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'box-shadow:0 12px 36px rgba(0,0,0,.28)'
  ].join(';');
  box.textContent = text;
  document.documentElement.appendChild(box);
  return { shown: true, state: window.AutoPlus.state() };
})()
`;
}

export function testCaptchaSlideExpression() {
  return String.raw`
(async () => {
  // autoplus-action: test-captcha-slide
  ${COMMON_PAGE_HELPERS}
  const A = window.AutoPlus;
  const slider = document.querySelector('.slider, [data-autoplus-test-slider], [role="slider"]');
  const container = document.querySelector('.sliderContainer, [data-autoplus-test-slider-container]')
    || slider?.parentElement
    || document.querySelector('#captcha__frame');
  if (!slider || !container || !A.visible(slider) || !A.visible(container)) {
    return { action: 'test-captcha-slide', moved: false, reason: 'slider-not-found', state: A.state() };
  }

  const from = slider.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  const startX = from.left + from.width / 2;
  const startY = from.top + from.height / 2;
  const endX = Math.max(startX, bounds.right - Math.max(4, from.width / 2));
  const steps = 18;
  const dispatch = (target, type, x, y) => {
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'pointerup' ? 0 : 1 };
    if (type.startsWith('pointer')) {
      try { target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch {}
    } else {
      target.dispatchEvent(new MouseEvent(type, init));
    }
  };

  dispatch(slider, 'pointerdown', startX, startY);
  dispatch(slider, 'mousedown', startX, startY);
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = startX + (endX - startX) * progress;
    const y = startY + Math.sin(progress * Math.PI) * 3;
    dispatch(document, 'pointermove', x, y);
    dispatch(document, 'mousemove', x, y);
    await A.sleep(18 + (step % 4) * 7);
  }
  dispatch(document, 'pointerup', endX, startY);
  dispatch(document, 'mouseup', endX, startY);
  return { action: 'test-captcha-slide', moved: true, state: A.state() };
})()
`;
}

export function payPalStepExpression(profileJson) {
  return String.raw`
(async () => {
  ${COMMON_PAGE_HELPERS}
  const A = window.AutoPlus;
  A.hideNoise();
  const profile = ${profileJson};
  const state = A.state();
  if (state.verificationInputs >= 6 && profile.verificationCode) {
    for (let index = 0; index < 6; index += 1) A.fillId('ci-ciBasic-' + index, profile.verificationCode[index] || '');
    return { action: 'verification', state: A.state() };
  }
  if (state.isPayPalLogin && !state.isPayPalGuest) {
    A.fillId('email', profile.email);
    await A.sleep(700);
    const button = A.findButton([/next|continue|login|log\s*in|sign\s*in/i, /下一页|下一步|继续|登录|登入/i]);
    if (button) A.click(button);
    return { action: 'login-email', state: A.state() };
  }
  if (state.isPayPalGuest) {
    const country = document.getElementById('country');
    if (country && String(country.value || '').toUpperCase() !== 'US') {
      country.value = 'US';
      country.dispatchEvent(new Event('change', { bubbles: true }));
      await A.sleep(2500);
    }
    A.fillId('email', profile.email);
    A.fillId('phone', profile.phone);
    A.fillId('cardNumber', profile.cardNumber);
    A.fillId('cardExpiry', profile.cardExpiry);
    A.fillId('cardCvv', profile.cardCvv);
    A.fillId('password', profile.password);
    A.fillId('firstName', profile.firstName);
    A.fillId('lastName', profile.lastName);
    A.fillId('billingLine1', profile.address.street || '');
    A.fillId('billingCity', profile.address.city || '');
    A.fillId('billingPostalCode', profile.address.zip || '');
    A.selectByText('billingState', profile.address.state || '');
    await A.sleep(800);
    const button = document.querySelector('button[data-testid="submit-button"]')
      || document.querySelector('button[data-testid="hosted-payment-submit-button"]')
      || A.findButton([/pay|continue|next|agree|subscribe/i, /支付|继续|下一步|同意|订阅/i]);
    if (button && !button.disabled) A.click(button);
    return { action: 'guest-checkout', state: A.state() };
  }
  if (state.isPayPalReview) {
    await A.sleep(2000);
    const button = document.getElementById('consentButton') || A.findButton([/agree\s*(?:and)?\s*continue|accept|continue/i, /同意并继续|同意|继续/i]);
    if (button) A.click(button);
    return { action: 'review-consent', state: A.state() };
  }
  const button = A.findButton([/agree\s*(?:and)?\s*continue|continue|accept|authorize|pay\s*now/i, /同意|继续|授权|确认/i]);
  if (button) {
    A.click(button);
    return { action: 'generic-approve', state: A.state() };
  }
  return { action: 'wait', state };
})()
`;
}
