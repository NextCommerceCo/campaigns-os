import { formatPrice } from "./format.js";

export const ready = true;
document.documentElement.dataset.price = formatPrice(0);
