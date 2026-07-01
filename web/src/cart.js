import { useEffect, useState } from 'react';

// Tiny cart store (module-level) with a React hook. Items: { variantId, productId, title, sku, image, unit, qty }.
const listeners = new Set();
let items = [];

function emit() {
  for (const fn of listeners) fn(items);
}

export const cart = {
  items: () => items,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  add(item) {
    const ex = items.find((i) => i.variantId === item.variantId);
    if (ex) items = items.map((i) => (i.variantId === item.variantId ? { ...i, qty: i.qty + (item.qty || 1) } : i));
    else items = [...items, { ...item, qty: item.qty || 1 }];
    emit();
  },
  setQty(variantId, qty) {
    items = items.map((i) => (i.variantId === variantId ? { ...i, qty } : i)).filter((i) => i.qty > 0);
    emit();
  },
  remove(variantId) {
    items = items.filter((i) => i.variantId !== variantId);
    emit();
  },
  clear() {
    items = [];
    emit();
  },
};

export function useCart() {
  const [it, setIt] = useState(items);
  useEffect(() => cart.subscribe(setIt), []);
  return it;
}

export const cartCount = (its) => its.reduce((s, i) => s + i.qty, 0);
export const cartSubtotal = (its) => its.reduce((s, i) => s + i.unit * i.qty, 0);
