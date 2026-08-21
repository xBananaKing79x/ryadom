"use client";
/* eslint-disable @next/next/no-img-element -- MCP returns external image URLs at runtime. */

import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Product = { id: string; seller_id?: string; title: string; description?: string; price: number | string; category: string; status?: string; created_at?: string; image?: string };
type Profile = { id: string; first_name?: string; last_name?: string; created_at?: string };
type Order = { id: string; product_id?: string; product?: Product; buyer_id?: string; seller_id?: string; status: string; created_at?: string };
type Message = { id: string; sender_id?: string; receiver_id?: string; text: string; created_at?: string; product_id?: string; order_id?: string };
type InboxMessage = Message & { product_id: string; productTitle: string };
type AgentOffer = { message: Message; product: Product; order?: Order; offered_price?: number };
type SaleAction = { kind: "requested_order" | "rejected" | "reserved" | "wallet_sent" | "payment_pending" | "payment_invalid" | "sold"; product_id: string; order_id?: string; detail: string };
type ImageRecord = { id?: string; url?: string; alt_text?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type AgentMessage = { role: "user" | "assistant"; content: string };
type PaymentDetails = { network: "Ethereum Sepolia"; chain_id: number; address: string; currency: "SepoliaETH"; amount_eth: string; value_wei_hex: string; explorer_url: string; faucet_url: string; transaction?: { hash: string; status: "pending" | "confirmed" | "failed" | "not_found"; finalized: boolean; recipient_matches: boolean; amount_eth?: string; block_number?: number; explorer_url: string } };
type EthereumProvider = { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> };
type Panel = "profile" | "products" | "orders" | "messages" | "agent" | "product" | "create" | "edit" | null;

const categories = [
  ["", "Все", "✦"], ["electronics", "Электроника", "⌁"], ["computers", "Компьютеры", "⌘"],
  ["phones", "Телефоны", "▣"], ["gaming", "Игры", "◇"], ["transport", "Транспорт", "◉"],
  ["home", "Для дома", "⌂"], ["clothes", "Одежда", "♢"], ["other", "Другое", "+"],
] as const;
const categoryNames = Object.fromEntries(categories.map(([value, label]) => [value, label]));
const statusNames: Record<string, string> = { ACTIVE: "Активно", RESERVED: "Зарезервировано", SOLD: "Продано", REMOVED: "Снято", CREATED: "Создан", ACCEPTED: "Подтверждён", CANCELLED: "Отменён", COMPLETED: "Завершён" };
const agentGreeting: AgentMessage = { role: "assistant", content: "Могу найти и купить товар или автономно провести ваши продажи: договориться, зарезервировать, проверить оплату и завершить сделку." };

function visibleOwnProducts(list: Product[]) {
  return list.filter((product) => product.status?.toUpperCase() !== "REMOVED");
}

function unwrap<T>(result?: McpResult): T {
  const value = result?.structuredContent as Record<string, unknown> | undefined;
  if (value) return ((value.result ?? value.items ?? value) as T);
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return [] as T;
  let parsed: Record<string, unknown> | T;
  try { parsed = JSON.parse(text) as Record<string, unknown> | T; }
  catch { return text as T; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return ((parsed.result ?? parsed.items ?? parsed) as T);
  return parsed as T;
}

async function mcpCall<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
  const responseText = await response.text();
  let payload: { result?: McpResult; error?: string };
  try { payload = JSON.parse(responseText) as typeof payload; }
  catch { throw new Error(response.ok ? "Платформа вернула некорректный ответ" : responseText || "Не удалось получить ответ платформы"); }
  if (!response.ok) throw new Error(payload.error || "Не удалось получить ответ платформы");
  if (payload.result?.isError) {
    const message = payload.result.content?.find((item) => item.type === "text")?.text;
    throw new Error(message || "Платформа отклонила операцию");
  }
  return unwrap<T>(payload.result);
}

function money(value: Product["price"]) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount)} ₽` : `${value} ₽`;
}

function shortDate(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
}

async function filePayload(file: File) {
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedTypes.has(file.type)) throw new Error("Выберите изображение JPEG, PNG или WebP");
  if (file.size > 5 * 1024 * 1024) throw new Error("Фотография должна быть не больше 5 МБ");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
  return { image_base64: dataUrl.split(",")[1], content_type: file.type };
}

function Modal({ title, eyebrow, close, children, wide = false }: { title: string; eyebrow: string; close: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section aria-modal="true" className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-label={title}>
      <div className="modal-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="close-button" onClick={close} type="button" aria-label="Закрыть">×</button></div>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span aria-hidden="true">⌁</span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

export function MarketplaceApp() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [myProducts, setMyProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [sellingProducts, setSellingProducts] = useState<Product[]>([]);
  const [orderRole, setOrderRole] = useState("all");
  const [selected, setSelected] = useState<Product | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [dealMessages, setDealMessages] = useState<Message[]>([]);
  const [dealPayment, setDealPayment] = useState<PaymentDetails | null>(null);
  const [dealLoading, setDealLoading] = useState(false);
  const [inboxMessages, setInboxMessages] = useState<InboxMessage[]>([]);
  const [readMessageIds, setReadMessageIds] = useState<string[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [messageContext, setMessageContext] = useState<{ productId: string; productTitle?: string; receiverId?: string; orderId?: string }>({ productId: "" });
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([agentGreeting]);
  const [agentProducts, setAgentProducts] = useState<Product[]>([]);
  const [agentOrders, setAgentOrders] = useState<Order[]>([]);
  const [agentOffers, setAgentOffers] = useState<AgentOffer[]>([]);
  const [agentRelistCandidates, setAgentRelistCandidates] = useState<Product[]>([]);
  const [agentSending, setAgentSending] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentPayment, setAgentPayment] = useState<PaymentDetails | null>(null);
  const [paymentSending, setPaymentSending] = useState(false);
  const [agentButtonPosition, setAgentButtonPosition] = useState<{ x: number; y: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentDrag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);

  const hydrateImages = useCallback(async (list: Product[], target: "catalog" | "mine" | "selling" = "catalog") => {
    await Promise.all(list.slice(0, 16).map(async (product) => {
      try {
        const images = await mcpCall<ImageRecord[]>("get_product_images", { product_id: product.id });
        if (!images?.[0]?.url) return;
        const patch = (current: Product[]) => current.map((item) => item.id === product.id ? { ...item, image: images[0].url } : item);
        if (target === "catalog") setProducts(patch); else if (target === "mine") setMyProducts(patch); else setSellingProducts(patch);
      } catch { /* Изображение необязательно. */ }
    }));
  }, []);

  const loadProducts = useCallback(async (nextQuery = query, nextCategory = category, nextSort = sort) => {
    setLoading(true); setError("");
    try {
      const args: Record<string, unknown> = { status: "ACTIVE", sort: nextSort, limit: 12 };
      if (nextQuery.trim()) args.query = nextQuery.trim(); if (nextCategory) args.category = nextCategory;
      if (minPrice) args.min_price = Number(minPrice); if (maxPrice) args.max_price = Number(maxPrice);
      const list = await mcpCall<Product[]>("search_products", args);
      const normalized = Array.isArray(list) ? list : []; setProducts(normalized); void hydrateImages(normalized);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Каталог временно недоступен"); }
    finally { setLoading(false); }
  }, [category, hydrateImages, maxPrice, minPrice, query, sort]);

  const loadNotifications = useCallback(async () => {
    setNotificationLoading(true);
    try {
      const currentProfile = await mcpCall<Profile>("get_my_profile");
      const ownProducts = await mcpCall<Product[]>("get_my_products", { limit: 20 });
      setProfile(currentProfile);
      const batches = await Promise.all((Array.isArray(ownProducts) ? ownProducts : []).map(async (product) => {
        try {
          const list = await mcpCall<Message[]>("get_messages", { product_id: product.id, limit: 20 });
          return (Array.isArray(list) ? list : [])
            .filter((message) => message.sender_id !== currentProfile.id)
            .map((message) => ({ ...message, product_id: product.id, productTitle: product.title }));
        } catch { return [] as InboxMessage[]; }
      }));
      const nextMessages = batches.flat().sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
      setInboxMessages(nextMessages);
      try {
        const stored = localStorage.getItem(`ryadom:read-messages:${currentProfile.id}`);
        setReadMessageIds(stored ? JSON.parse(stored) as string[] : []);
      } catch { setReadMessageIds([]); }
    } catch { /* Колокольчик остаётся доступным даже при временном сбое MCP. */ }
    finally { setNotificationLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadProducts("", "", "created_desc"), 0);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setTimeout(() => void loadNotifications(), 600);
    return () => clearTimeout(timer);
  }, [loadNotifications]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ automation: "sales" }) });
        const payload = await response.json() as { actions?: SaleAction[] };
        const materialActions = Array.isArray(payload.actions) ? payload.actions.filter((action) => action.kind !== "payment_pending") : [];
        if (!stopped && materialActions.length) {
          showToast(materialActions.some((action) => action.kind === "sold") ? "Агент завершил продажу" : "Агент обновил сделки");
          void loadNotifications();
          void loadProducts();
        }
      } catch { /* Автопроверка повторится через минуту. */ }
      finally { running = false; }
    };
    const firstTick = setTimeout(() => void tick(), 5000);
    const interval = setInterval(() => void tick(), 60_000);
    return () => { stopped = true; clearTimeout(firstTick); clearInterval(interval); };
  }, [loadNotifications, loadProducts, showToast]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stored = localStorage.getItem("ryadom:agent-button-position");
      if (!stored) return;
      const position = JSON.parse(stored) as { x?: number; y?: number };
      if (typeof position.x === "number" && typeof position.y === "number" && Number.isFinite(position.x) && Number.isFinite(position.y)) timer = setTimeout(() => setAgentButtonPosition({ x: Math.max(8, Math.min(window.innerWidth - 82, position.x as number)), y: Math.max(72, Math.min(window.innerHeight - 82, position.y as number)) }), 0);
    } catch { /* Оставляем кнопку в позиции по умолчанию. */ }
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (panel !== "product" || !selected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setDealMessages([]); setDealPayment(null); setDealLoading(true); setActionError("");
      void Promise.allSettled([
        mcpCall<Message[]>("get_messages", { product_id: selected.id, limit: 100 }),
        fetch("/api/ethereum").then(async (response) => {
          const payload = await response.json() as { payment?: PaymentDetails; error?: string };
          if (!response.ok || !payload.payment) throw new Error(payload.error || "Реквизиты сделки недоступны");
          return payload.payment;
        }),
      ]).then(([messageResult, paymentResult]) => {
        if (cancelled) return;
        if (messageResult.status === "fulfilled") setDealMessages(Array.isArray(messageResult.value) ? messageResult.value : []);
        if (paymentResult.status === "fulfilled") setDealPayment(paymentResult.value);
        if (messageResult.status === "rejected" && paymentResult.status === "rejected") setActionError("Не удалось загрузить данные сделки");
        setDealLoading(false);
      });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [panel, selected]);

  function saveReadMessages(ids: string[]) {
    const unique = [...new Set(ids)].slice(-500);
    setReadMessageIds(unique);
    if (profile?.id) localStorage.setItem(`ryadom:read-messages:${profile.id}`, JSON.stringify(unique));
  }

  function markAllMessagesRead() {
    saveReadMessages([...readMessageIds, ...inboxMessages.map((message) => message.id)]);
  }

  function openInboxMessage(message: InboxMessage) {
    saveReadMessages([...readMessageIds, message.id]);
    setNotificationOpen(false);
    void openMessages({ productId: message.product_id, productTitle: message.productTitle, receiverId: message.sender_id, orderId: message.order_id });
  }

  async function openProfile() {
    setPanel("profile"); setPanelLoading(true);
    try { setProfile(await mcpCall<Profile>("get_my_profile")); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось открыть профиль"); }
    finally { setPanelLoading(false); }
  }

  async function openMyProducts() {
    setPanel("products"); setPanelLoading(true); setActionError("");
    try { const list = await mcpCall<Product[]>("get_my_products", { limit: 50 }); const visible = visibleOwnProducts(Array.isArray(list) ? list : []); setMyProducts(visible); void hydrateImages(visible, "mine"); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось загрузить продукты"); } finally { setPanelLoading(false); }
  }

  async function openOrders(role = orderRole) {
    setPanel("orders"); setPanelLoading(true); setActionError("");
    try {
      const [list, products] = await Promise.all([
        mcpCall<Order[]>("get_my_orders", { role, limit: 50 }),
        role === "seller" ? mcpCall<Product[]>("get_my_products", { limit: 100 }) : Promise.resolve([] as Product[]),
      ]);
      setOrders(Array.isArray(list) ? list : []); setSellingProducts(Array.isArray(products) ? products : []);
      if (role === "seller") void hydrateImages(Array.isArray(products) ? products : [], "selling");
    }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось загрузить заказы"); } finally { setPanelLoading(false); }
  }

  async function openMessages(context?: Partial<typeof messageContext>) {
    const next = { ...messageContext, ...context }; setMessageContext(next); setPanel("messages"); setMessages([]); setActionError("");
    if (!next.productId) return;
    setPanelLoading(true);
    try {
      const args: Record<string, unknown> = { product_id: next.productId, limit: 100 };
      if (next.receiverId) args.participant_id = next.receiverId; if (next.orderId) args.order_id = next.orderId;
      const list = await mcpCall<Message[]>("get_messages", args); setMessages(Array.isArray(list) ? list : []);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось загрузить сообщения"); } finally { setPanelLoading(false); }
  }

  function openProduct(product: Product) { setSelected(product); setPanel("product"); }

  async function sendDealMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget; const text = String(new FormData(formElement).get("deal_message") || "").trim();
    if (!text) return;
    setActing(true); setActionError("");
    try {
      const args: Record<string, unknown> = { product_id: selected.id, text };
      if (selected.seller_id) args.receiver_id = selected.seller_id;
      await mcpCall("send_message", args); formElement.reset();
      const list = await mcpCall<Message[]>("get_messages", { product_id: selected.id, limit: 100 });
      setDealMessages(Array.isArray(list) ? list : []); showToast("Сообщение продавцу отправлено");
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Сообщение не отправлено"); }
    finally { setActing(false); }
  }

  async function verifyDealTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const hash = String(new FormData(event.currentTarget).get("transaction_hash") || "").trim();
    setDealLoading(true); setActionError("");
    try {
      const response = await fetch("/api/ethereum", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction_hash: hash }) });
      const payload = await response.json() as { payment?: PaymentDetails; error?: string };
      if (!response.ok || !payload.payment) throw new Error(payload.error || "Транзакция не проверена");
      setDealPayment(payload.payment);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось проверить транзакцию"); }
    finally { setDealLoading(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const text = String(form.get("text") || "").trim(); if (!text || !messageContext.productId) return;
    setActing(true); setActionError("");
    try {
      const args: Record<string, unknown> = { product_id: messageContext.productId, text };
      if (messageContext.receiverId) args.receiver_id = messageContext.receiverId; if (messageContext.orderId) args.order_id = messageContext.orderId;
      await mcpCall("send_message", args); event.currentTarget.reset(); showToast("Сообщение отправлено"); await openMessages();
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Сообщение не отправлено"); } finally { setActing(false); }
  }

  async function runAgentTask(text: string) {
    const cleanText = text.trim();
    if (!cleanText || agentSending) return;
    const nextHistory = [...agentMessages, { role: "user" as const, content: cleanText }].slice(-18);
    setAgentMessages(nextHistory); setAgentSending(true); setAgentError("");
    try {
      const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: nextHistory }) });
      const responseText = await response.text();
      let payload: { message?: string; products?: Product[]; orders?: Order[]; offers?: AgentOffer[]; relist_candidates?: Product[]; payment?: PaymentDetails; error?: string };
      try { payload = JSON.parse(responseText) as typeof payload; }
      catch { throw new Error("Агент вернул некорректный ответ"); }
      if (!response.ok) throw new Error(payload.error || "Агент временно недоступен");
      setAgentMessages((current) => [...current, { role: "assistant", content: payload.message || "Готово." }].slice(-18));
      if (Array.isArray(payload.products) && payload.products.length) { setAgentProducts(payload.products); setAgentOrders([]); }
      if (Array.isArray(payload.orders) && payload.orders.length) { setAgentOrders(payload.orders); setAgentProducts([]); }
      if (Array.isArray(payload.offers)) { setAgentOffers(payload.offers); if (payload.offers.length) { setAgentProducts([]); setAgentOrders([]); setAgentRelistCandidates([]); } }
      if (Array.isArray(payload.relist_candidates)) { setAgentRelistCandidates(payload.relist_candidates); if (payload.relist_candidates.length) { setAgentProducts([]); setAgentOrders([]); setAgentOffers([]); } }
      if (payload.payment) setAgentPayment(payload.payment);
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось выполнить задачу"); }
    finally { setAgentSending(false); }
  }

  async function submitAgentTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = String(form.get("agent_task") || "");
    formElement.reset();
    await runAgentTask(text);
  }

  async function createAgentOrder(product: Product) {
    if (!window.confirm(`Создать заказ на «${product.title}» за ${money(product.price)}?`)) return;
    setActing(true); setAgentError("");
    try {
      await mcpCall("create_order", { product_id: product.id });
      setAgentMessages((current) => [...current, { role: "assistant", content: `Заказ на «${product.title}» создан. Теперь продавец может его подтвердить.` }].slice(-18));
      showToast("Заказ создан");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось создать заказ"); }
    finally { setActing(false); }
  }

  async function sendSepoliaPayment(payment: PaymentDetails | null = agentPayment, source: "agent" | "deal" = "agent") {
    if (!payment || paymentSending) return;
    const ethereum = (window as typeof window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum) { setAgentError("Установите браузерный Ethereum-кошелёк, например MetaMask, и включите сеть Sepolia."); return; }
    setPaymentSending(true); setAgentError("");
    try {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
      const from = accounts?.[0];
      if (!from) throw new Error("Кошелёк не вернул адрес отправителя");
      try { await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); }
      catch (reason) {
        if ((reason as { code?: number })?.code !== 4902) throw reason;
        await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xaa36a7", chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], blockExplorerUrls: ["https://sepolia.etherscan.io"] }] });
      }
      const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: payment.address, value: payment.value_wei_hex }] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Кошелёк не вернул хэш транзакции");
      const explorerUrl = `https://sepolia.etherscan.io/tx/${hash}`;
      const nextPayment = { ...payment, transaction: { hash, status: "pending" as const, finalized: false, recipient_matches: true, amount_eth: payment.amount_eth, explorer_url: explorerUrl } };
      if (source === "agent") setAgentPayment(nextPayment); else setDealPayment(nextPayment);
      const report = `Тестовый перевод ${payment.amount_eth} SepoliaETH отправлен. Хэш транзакции: ${hash}. Статус пока ожидает подтверждения в блокчейне.`;
      setAgentMessages((current) => [...current, { role: "assistant", content: report }].slice(-18));
      if (source === "deal" && selected) {
        try {
          const args: Record<string, unknown> = { product_id: selected.id, text: report };
          if (selected.seller_id) args.receiver_id = selected.seller_id;
          await mcpCall("send_message", args);
          const list = await mcpCall<Message[]>("get_messages", { product_id: selected.id, limit: 100 });
          setDealMessages(Array.isArray(list) ? list : []);
        } catch { setAgentError("Перевод отправлен, но сообщение с хэшем не доставлено продавцу. Скопируйте хэш из блока сделки."); }
      }
      showToast("Тестовый перевод отправлен");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось отправить тестовый перевод"); }
    finally { setPaymentSending(false); }
  }

  async function acceptAgentOrder(order: Order) {
    if (!window.confirm("Подтвердить этот заказ? Товар перейдёт в статус «На холде», остальные заявки будут отменены.")) return;
    setActing(true); setAgentError("");
    try {
      await mcpCall("accept_order", { order_id: order.id });
      setAgentOrders((current) => current.map((item) => item.id === order.id ? { ...item, status: "ACCEPTED" } : item.product_id === order.product_id && item.status === "CREATED" ? { ...item, status: "CANCELLED" } : item));
      setAgentMessages((current) => [...current, { role: "assistant", content: "Заказ подтверждён. Товар поставлен на холд, остальные активные заявки по нему отменены платформой." }].slice(-18));
      showToast("Заказ подтверждён — товар на холде");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось подтвердить заказ"); }
    finally { setActing(false); }
  }

  async function sendOfferReply(offer: AgentOffer, text: string) {
    const args: Record<string, unknown> = { product_id: offer.product.id, receiver_id: offer.message.sender_id, text };
    if (offer.order?.id) args.order_id = offer.order.id;
    await mcpCall("send_message", args);
  }

  async function replyAboutAvailability(offer: AgentOffer) {
    setActing(true); setAgentError("");
    try {
      const available = offer.product.status === "ACTIVE";
      await sendOfferReply(offer, available ? `Здравствуйте! Да, «${offer.product.title}» доступен. Цена объявления — ${money(offer.product.price)}.` : `Здравствуйте! «${offer.product.title}» сейчас на холде. Я сообщу, если товар снова станет доступен.`);
      showToast("Ответ покупателю отправлен");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось отправить ответ"); }
    finally { setActing(false); }
  }

  async function requestOrderForOffer(offer: AgentOffer) {
    setActing(true); setAgentError("");
    try {
      await sendOfferReply(offer, `Спасибо за предложение ${offer.offered_price ? money(offer.offered_price) : "цены"}. Чтобы продавец мог поставить товар в резерв, пожалуйста, создайте заказ из карточки товара.`);
      showToast("Покупателю предложено создать заказ");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось отправить ответ"); }
    finally { setActing(false); }
  }

  async function reserveAgentOffer(offer: AgentOffer) {
    if (!offer.order || offer.order.status !== "CREATED") return;
    const offered = offer.offered_price ?? Number(offer.product.price);
    if (!window.confirm(`Поставить «${offer.product.title}» в резерв для согласования предложения ${money(offered)}? Это ещё не завершает продажу.`)) return;
    setActing(true); setAgentError("");
    try {
      await mcpCall("accept_order", { order_id: offer.order.id });
      await sendOfferReply(offer, `Товар поставлен в резерв. Ваше предложение ${money(offered)} передано продавцу на согласование. Продажа ещё не подтверждена.`);
      setAgentOffers((current) => current.map((item) => item.order?.id === offer.order?.id ? { ...item, product: { ...item.product, status: "RESERVED" }, order: item.order ? { ...item.order, status: "ACCEPTED" } : item.order } : item));
      showToast("Товар на холде — ждёт решения");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось поставить товар в резерв"); }
    finally { setActing(false); }
  }

  async function approveAgentOffer(offer: AgentOffer) {
    if (!offer.order || offer.order.status !== "ACCEPTED") return;
    const offered = offer.offered_price ?? Number(offer.product.price);
    if (!window.confirm(`Подтвердить продажу по согласованной в сообщениях цене ${money(offered)}?`)) return;
    setActing(true); setAgentError("");
    try {
      await sendOfferReply(offer, `Продавец согласился продать товар за ${money(offered)}. Цена согласована в переписке. Завершаем сделку.`);
      await mcpCall("complete_order", { order_id: offer.order.id });
      setAgentOffers((current) => current.map((item) => item.order?.id === offer.order?.id ? { ...item, product: { ...item.product, status: "SOLD" }, order: item.order ? { ...item.order, status: "COMPLETED" } : item.order } : item));
      showToast("Продажа завершена");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось завершить продажу"); }
    finally { setActing(false); }
  }

  async function declineAgentOffer(offer: AgentOffer) {
    if (!offer.order || !["CREATED", "ACCEPTED"].includes(offer.order.status)) return;
    if (!window.confirm("Отклонить предложение? Если товар был на холде, он снова станет доступен.")) return;
    setActing(true); setAgentError("");
    try {
      await sendOfferReply(offer, `Спасибо за предложение. Цена товара выше — ${money(offer.product.price)}. Предложение отклонено, резерв снят.`);
      await mcpCall("cancel_order", { order_id: offer.order.id });
      setAgentOffers((current) => current.map((item) => item.order?.id === offer.order?.id ? { ...item, product: { ...item.product, status: "ACTIVE" }, order: item.order ? { ...item.order, status: "CANCELLED" } : item.order } : item));
      showToast("Предложение отклонено, резерв снят");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось отклонить предложение"); }
    finally { setActing(false); }
  }

  async function relistPurchasedProduct(product: Product) {
    const originalPrice = Number(product.price); const resalePrice = Math.round(originalPrice * 1.15 * 100) / 100;
    if (!Number.isFinite(resalePrice) || resalePrice <= 0) { setAgentError("Не удалось рассчитать цену перепродажи"); return; }
    if (!window.confirm(`Выставить «${product.title}» за ${money(resalePrice)} — на 15% выше цены покупки?`)) return;
    setActing(true); setAgentError("");
    try {
      await mcpCall("create_product", { title: product.title, description: `${product.description || "Купленный товар"}\n\nПовторно выставлено через агента «Рядом».`, price: resalePrice, category: product.category });
      setAgentRelistCandidates((current) => current.filter((item) => item.id !== product.id));
      showToast("Товар выставлен с наценкой 15%");
    } catch (reason) { setAgentError(reason instanceof Error ? reason.message : "Не удалось выставить товар"); }
    finally { setActing(false); }
  }

  function beginAgentDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    agentDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveAgentButton(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = agentDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX; const deltaY = event.clientY - drag.startY;
    if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
    if (!drag.moved) return;
    setAgentButtonPosition({ x: Math.max(8, Math.min(window.innerWidth - 82, drag.originX + deltaX)), y: Math.max(72, Math.min(window.innerHeight - 82, drag.originY + deltaY)) });
  }

  function finishAgentDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = agentDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    agentDrag.current = null;
    if (drag.moved) {
      setAgentButtonPosition((position) => { if (position) localStorage.setItem("ryadom:agent-button-position", JSON.stringify(position)); return position; });
    } else { setPanel("agent"); setAgentError(""); }
  }

  async function createOrUpdateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setActing(true); setActionError("");
    try {
      const args = { title: String(form.get("title")), description: String(form.get("description")), price: Number(form.get("price")), category: String(form.get("category")) };
      const isEdit = panel === "edit" && selected; const result = isEdit ? await mcpCall<Product>("update_product", { product_id: selected.id, ...args }) : await mcpCall<Product>("create_product", args);
      const productId = result?.id || selected?.id; const file = form.get("image") as File;
      if (productId && file?.size) { const image = await filePayload(file); await mcpCall("add_product_image", { product_id: productId, ...image, alt_text: args.title }); }
      showToast(isEdit ? "Объявление обновлено" : "Объявление опубликовано"); setPanel(null); await loadProducts();
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось сохранить объявление"); } finally { setActing(false); }
  }

  async function removeProduct(product: Product) {
    if (!window.confirm(`Снять объявление «${product.title}» с площадки?`)) return;
    setActing(true); setActionError(""); try {
      await mcpCall("remove_product", { product_id: product.id });
      setMyProducts((current) => current.filter((item) => item.id !== product.id));
      setSellingProducts((current) => current.filter((item) => item.id !== product.id));
      setProducts((current) => current.filter((item) => item.id !== product.id));
      showToast("Товар снят и удалён из списка");
    }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось снять объявление"); } finally { setActing(false); }
  }

  async function createOrder(product: Product) {
    if (!window.confirm(`Создать заказ на «${product.title}» за ${money(product.price)}?`)) return;
    setActing(true); setActionError(""); try { await mcpCall("create_order", { product_id: product.id }); showToast("Заказ создан"); setPanel(null); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось создать заказ"); } finally { setActing(false); }
  }

  async function changeOrder(order: Order, action: "accept_order" | "cancel_order" | "complete_order") {
    const labels = { accept_order: "подтвердить", cancel_order: "отменить", complete_order: "завершить" };
    if (!window.confirm(`Вы уверены, что хотите ${labels[action]} заказ?`)) return;
    setActing(true); try { await mcpCall(action, { order_id: order.id }); showToast(action === "cancel_order" ? "Заказ отменён" : action === "accept_order" ? "Заказ подтверждён" : "Заказ завершён"); await openOrders(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось изменить заказ"); } finally { setActing(false); }
  }

  const profileName = useMemo(() => [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "Пользователь", [profile]);
  const unreadMessages = useMemo(() => inboxMessages.filter((message) => !readMessageIds.includes(message.id)), [inboxMessages, readMessageIds]);
  const agentSortedOrders = useMemo(() => [...agentOrders].sort((left, right) => Number(right.product?.price || 0) - Number(left.product?.price || 0)), [agentOrders]);
  const bestAgentOrderId = agentSortedOrders.find((order) => order.status === "CREATED")?.id;
  function chooseCategory(value: string) { setCategory(value); void loadProducts(query, value, sort); }

  return <main id="top">
    <header className="site-header">
      <a className="brand" href="#top" aria-label="Рядом — на главную"><span className="brand-mark" aria-hidden="true">Р</span><span>рядом</span></a>
      <nav className="top-nav" aria-label="Личный кабинет">
        <button onClick={() => void openMyProducts()} type="button"><span className="nav-icon">□</span>Мои продукты</button>
        <button onClick={() => void openOrders()} type="button"><span className="nav-icon">⌁</span>Мои заказы</button>
        <div className="notification-wrap">
          <button className={`notification-button ${unreadMessages.length ? "has-unread" : ""}`} aria-expanded={notificationOpen} aria-label={unreadMessages.length ? `Новые сообщения: ${unreadMessages.length}` : "Новых сообщений нет"} onClick={() => { const next = !notificationOpen; setNotificationOpen(next); if (next) void loadNotifications(); }} type="button">
            <span className="bell-glyph" aria-hidden="true" />
            {unreadMessages.length > 0 && <span className="notification-count">{unreadMessages.length > 99 ? "99+" : unreadMessages.length}</span>}
          </button>
          {notificationOpen && <section className="notification-dropdown" aria-label="Новые сообщения">
            <div className="notification-head"><div><strong>Сообщения</strong><span>{unreadMessages.length ? `${unreadMessages.length} непрочитанных` : "Новых сообщений нет"}</span></div><button aria-label="Обновить сообщения" disabled={notificationLoading} onClick={() => void loadNotifications()} type="button">↻</button></div>
            <div className="notification-list">{notificationLoading && inboxMessages.length === 0 ? <p className="notification-empty">Проверяем сообщения…</p> : inboxMessages.length === 0 ? <p className="notification-empty">Когда вам напишут по товару, сообщение появится здесь.</p> : inboxMessages.slice(0, 8).map((message) => <button className={!readMessageIds.includes(message.id) ? "notification-item unread" : "notification-item"} key={message.id} onClick={() => openInboxMessage(message)} type="button"><span className="notification-avatar">{message.productTitle.charAt(0)}</span><span className="notification-copy"><strong>{message.productTitle}</strong><span>{message.text}</span><small>{shortDate(message.created_at)}</small></span>{!readMessageIds.includes(message.id) && <i aria-label="Непрочитанное сообщение" />}</button>)}</div>
            <div className="notification-footer"><button disabled={unreadMessages.length === 0} onClick={markAllMessagesRead} type="button">✓ Отметить все прочитанными</button></div>
          </section>}
        </div>
        <button className="profile-button" onClick={() => void openProfile()} type="button"><span aria-hidden="true">●</span> Профиль</button>
      </nav>
    </header>

    <section className="hero">
      <div className="hero-copy"><p className="eyebrow">Маркетплейс своего города</p><h1>Найдётся <em>рядом</em></h1><p className="hero-description">Лови классные вещи, общайся напрямую и забирай без долгого ожидания.</p><div className="hero-tags" aria-label="Преимущества"><span>⚡ Быстро</span><span>☺ Без комиссий</span><span>↗ Из рук в руки</span></div></div>
      <div className="hero-art"><div className="hero-art-image"><img src="/hero-marketplace-v3.png" alt="Велосипед, одежда, техника и посылка с площадки «Рядом»" fetchPriority="high" /></div><span className="art-sticker">бережно<br />из рук в руки</span><span className="art-spark">✦</span></div>
    </section>

    <section className="search-zone" aria-label="Поиск объявлений">
      <div className="category-scroll">{categories.map(([value, label, icon]) => <button className={category === value ? "category-chip active" : "category-chip"} key={value || "all"} onClick={() => chooseCategory(value)} type="button"><span aria-hidden="true">{icon}</span>{label}</button>)}</div>
      <form className="search-form" onSubmit={(event) => { event.preventDefault(); void loadProducts(); }}><span className="search-icon" aria-hidden="true">⌕</span><input aria-label="Что вы ищете" onChange={(event) => setQuery(event.target.value)} placeholder="Что ищем сегодня?" value={query} /><button type="submit">Искать</button></form>
      <div className="filter-row">
        <div className="filter-cluster"><label>Сортировка<select value={sort} onChange={(event) => { setSort(event.target.value); void loadProducts(query, category, event.target.value); }}><option value="created_desc">Сначала новые</option><option value="price_asc">Сначала дешевле</option><option value="price_desc">Сначала дороже</option><option value="created_asc">Сначала старые</option><option disabled>По просмотрам — скоро</option></select></label><div className="price-filter"><span>Цена</span><input aria-label="Цена от" inputMode="numeric" placeholder="от" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /><input aria-label="Цена до" inputMode="numeric" placeholder="до" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /><button type="button" aria-label="Применить цену" onClick={() => void loadProducts()}>→</button></div></div>
        <button className="add-button" onClick={() => { setSelected(null); setPanel("create"); }} type="button"><span aria-hidden="true">＋</span> Добавить продукт</button>
      </div>
    </section>

    <section className="catalog" aria-labelledby="catalog-title">
      <div className="section-heading"><div><p className="eyebrow">Свежее в ленте</p><h2 id="catalog-title">Новое рядом</h2></div>{!loading && !error && <span>{products.length} предложений</span>}</div>
      {error ? <div className="notice error"><strong>Каталог не загрузился</strong><span>{error}</span><button type="button" onClick={() => void loadProducts()}>Повторить</button></div> : loading ? <div className="product-grid" aria-label="Загрузка">{Array.from({ length: 8 }).map((_, index) => <div className="product-card skeleton" key={index} />)}</div> : products.length === 0 ? <div className="notice"><strong>Ничего не нашли</strong><span>Попробуйте изменить запрос или категорию.</span></div> : <div className="product-grid">{products.map((product) => <article className="product-card" key={product.id}><button className={`product-image category-${product.category}`} onClick={() => void openProduct(product)} type="button">{product.image ? <img src={product.image} alt="" /> : <span>{categoryNames[product.category] || "Находка"}</span>}<i aria-hidden="true">♡</i></button><div className="product-info"><span className="product-category">{categoryNames[product.category] || product.category}</span><h3>{product.title}</h3><strong>{money(product.price)}</strong><div className="card-actions"><button className="card-link" onClick={() => void openProduct(product)} type="button">Посмотреть <span aria-hidden="true">↗</span></button><button className="message-link" aria-label={`Написать по объявлению «${product.title}»`} onClick={() => void openMessages({ productId: product.id, productTitle: product.title })} type="button"><span aria-hidden="true">○</span> Написать</button></div></div></article>)}</div>}
    </section>

    <section className="trust-band"><div><span className="trust-number">01</span><strong>Живые объявления</strong><p>Каталог обновляется напрямую с платформы.</p></div><div><span className="trust-number">02</span><strong>Диалог до сделки</strong><p>Задайте продавцу вопросы в личных сообщениях.</p></div><div><span className="trust-number">03</span><strong>Понятный заказ</strong><p>Создайте, подтвердите или отмените сделку.</p></div></section>
    <footer><a className="brand" href="#top"><span className="brand-mark">Р</span><span>рядом</span></a><span>Вещи меняют хозяев. Город становится ближе.</span><button onClick={() => { setSelected(null); setPanel("create"); }} type="button">Разместить объявление ↗</button></footer>

    {panel === "profile" && <Modal eyebrow="Личный кабинет" title="Ваш профиль" close={() => setPanel(null)}>{panelLoading ? <div className="panel-loader">Загружаем…</div> : profile ? <div className="profile-card"><div className="avatar">{profileName.charAt(0)}</div><div><h3>{profileName}</h3><p>На «Рядом» с {shortDate(profile.created_at)}</p><small>ID · {profile.id}</small></div></div> : <EmptyState title="Профиль недоступен" text={actionError || "Попробуйте открыть его снова."} />}</Modal>}

    {panel === "products" && <Modal eyebrow="Ваши объявления" title="Мои продукты" wide close={() => setPanel(null)}><div className="panel-actions"><button className="primary-action" onClick={() => { setSelected(null); setPanel("create"); }} type="button">＋ Добавить продукт</button></div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем продукты…</div> : myProducts.length === 0 ? <EmptyState title="Пока нет объявлений" text="Первое объявление можно разместить за пару минут." action={<button className="text-action" onClick={() => setPanel("create")} type="button">Добавить продукт →</button>} /> : <div className="compact-list">{myProducts.map((product) => <article key={product.id}><div className={`compact-image category-${product.category}`}>{product.image ? <img src={product.image} alt="" /> : categoryNames[product.category]}</div><div><span className={`status-badge status-${product.status?.toLowerCase()}`}>{statusNames[product.status || ""] || product.status}</span><h3>{product.title}</h3><strong>{money(product.price)}</strong></div><div className="item-actions"><button onClick={() => { setSelected(product); setPanel("edit"); }} type="button">Редактировать</button><button className="danger-action" disabled={acting} onClick={() => void removeProduct(product)} type="button">Снять</button></div></article>)}</div>}</Modal>}

    {(panel === "create" || panel === "edit") && <Modal eyebrow={panel === "edit" ? "Редактирование" : "Новое объявление"} title={panel === "edit" ? "Обновить продукт" : "Добавить продукт"} close={() => setPanel(null)}><form className="product-form" onSubmit={createOrUpdateProduct}><label>Название<input name="title" minLength={3} maxLength={200} required defaultValue={panel === "edit" ? selected?.title : ""} placeholder="Например, торшер из дерева" /></label><label>Описание<textarea name="description" minLength={1} maxLength={5000} required defaultValue={panel === "edit" ? selected?.description : ""} placeholder="Состояние, комплект, детали передачи" /></label><div className="form-grid"><label>Цена, ₽<input name="price" type="number" min="0.01" step="0.01" required defaultValue={panel === "edit" ? String(selected?.price || "") : ""} placeholder="2500" /></label><label>Категория<select name="category" required defaultValue={panel === "edit" ? selected?.category : "home"}>{categories.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label className="file-field">Фотография<input name="image" type="file" accept="image/jpeg,image/png,image/webp" /><span>{panel === "edit" ? "Выберите новое фото, чтобы добавить его" : "JPEG, PNG или WebP"}</span></label>{actionError && <p className="inline-error">{actionError}</p>}<button className="submit-action" disabled={acting} type="submit">{acting ? "Сохраняем…" : panel === "edit" ? "Сохранить изменения" : "Опубликовать продукт"}</button></form></Modal>}

    {panel === "agent" && <Modal eyebrow="DeepSeek × MCP" title="Агент по сделкам" wide close={() => setPanel(null)}><div className="agent-shell">
      <aside className="agent-aside"><div className="agent-orb" aria-hidden="true">✦</div><strong>Что поручить?</strong><p>Агент ищет товары, общается с контрагентами и ведёт разрешённые сделки по заданным правилам.</p><div className="agent-prompts"><button onClick={() => void runAgentTask("Хочу найти товар. Спроси у меня категорию, бюджет и важные параметры.")} type="button">Найти товар</button><button onClick={() => void runAgentTask("Найди товары в статусе RESERVED — на холде. Сначала уточни, что именно искать.")} type="button">Поиск на холде</button><button onClick={() => void runAgentTask("Автономно обработай все текущие продажи: сообщения, торг, заказы, резерв и финализированные оплаты по правилу 90%.")} type="button">Провести продажи</button><button onClick={() => void runAgentTask("Проверь входящие сообщения по моим товарам без изменения заказов.")} type="button">Только проверить</button><button onClick={() => void runAgentTask("Покажи завершённые покупки, которые можно выставить на продажу с наценкой 15%.")} type="button">Перепродать +15%</button><button onClick={() => void runAgentTask("Покажи реквизиты для тестовой оплаты в Ethereum Sepolia.")} type="button">Тестовая оплата ETH</button></div><small>Продажи агент проводит автономно: принимает предложения от 90% цены и завершает только финализированную оплату.</small></aside>
      <section className="agent-workspace"><div className="agent-chat" aria-live="polite">{agentMessages.map((message, index) => <article className={`agent-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "assistant" ? "Р" : "Вы"}</span><p>{message.content}</p></article>)}{agentSending && <article className="agent-message assistant thinking"><span>Р</span><p>Ищу и сравниваю…</p></article>}</div>
        {agentError && <p className="inline-error">{agentError}</p>}
        {agentPayment && <div className="agent-payment"><div className="agent-payment-head"><div><span>Тестовая сеть</span><strong>Ethereum Sepolia</strong></div><i>не реальные деньги</i></div><div className="agent-payment-address"><small>Кошелёк получателя</small><code>{agentPayment.address}</code></div><div className="agent-payment-meta"><span>Сумма <strong>{agentPayment.amount_eth} SepoliaETH</strong></span><a href={agentPayment.explorer_url} target="_blank" rel="noreferrer">Кошелёк в Etherscan ↗</a></div>{agentPayment.transaction && <div className={`agent-payment-status status-${agentPayment.transaction.status}`}><span>{agentPayment.transaction.status === "confirmed" ? agentPayment.transaction.finalized ? "✓ Финализировано" : "◌ Подтверждено, ждём финализации" : agentPayment.transaction.status === "failed" ? "× Ошибка" : agentPayment.transaction.status === "not_found" ? "? Не найдено" : "◌ Ожидает подтверждения"}</span><code>{agentPayment.transaction.hash}</code><a href={agentPayment.transaction.explorer_url} target="_blank" rel="noreferrer">Открыть транзакцию ↗</a>{!agentPayment.transaction.recipient_matches && <strong>Адрес получателя не совпадает</strong>}</div>}<div className="agent-payment-actions"><button disabled={paymentSending} onClick={() => void sendSepoliaPayment()} type="button">{paymentSending ? "Откройте кошелёк…" : "Оплатить через кошелёк"}</button>{agentPayment.transaction && <button disabled={agentSending} onClick={() => void runAgentTask(`Проверь статус тестовой Sepolia-транзакции ${agentPayment.transaction?.hash}`)} type="button">Проверить статус</button>}<a href={agentPayment.faucet_url} target="_blank" rel="noreferrer">Где взять тестовый ETH</a></div></div>}
        {agentProducts.length > 0 && <div className="agent-results"><div className="agent-results-head"><strong>Найденные предложения</strong><span>{agentProducts.length}</span></div><div className="agent-product-strip">{agentProducts.map((product) => <article className="agent-product-card" key={product.id}><button className={`agent-product-image category-${product.category}`} onClick={() => void openProduct(product)} type="button">{product.image ? <img src={product.image} alt="" /> : <span>{categoryNames[product.category] || "Товар"}</span>}<i>{statusNames[product.status || "ACTIVE"] || product.status}</i></button><div><small>{categoryNames[product.category] || product.category}</small><h3>{product.title}</h3><strong>{money(product.price)}</strong><div className="agent-card-actions"><button onClick={() => void openProduct(product)} type="button">Карточка</button>{product.status === "ACTIVE" && <button disabled={acting} onClick={() => void createAgentOrder(product)} type="button">Создать заказ</button>}</div></div></article>)}</div></div>}
        {agentOffers.length > 0 && <div className="agent-results"><div className="agent-results-head"><strong>Сообщения и предложения</strong><span>{agentOffers.length}</span></div><div className="agent-offer-list">{agentOffers.map((offer) => { const listed = Number(offer.product.price); const belowPrice = offer.offered_price !== undefined && offer.offered_price < listed; return <article className={belowPrice ? "agent-offer below-price" : "agent-offer"} key={offer.message.id}><div className="agent-offer-head"><div><span className={`status-badge status-${offer.product.status?.toLowerCase()}`}>{statusNames[offer.product.status || "ACTIVE"]}</span><strong>{offer.product.title}</strong></div><div><small>Цена объявления</small><strong>{money(offer.product.price)}</strong></div></div><blockquote>{offer.message.text}</blockquote>{offer.offered_price !== undefined && <div className="agent-price-check"><span>Предложение покупателя</span><strong>{money(offer.offered_price)}</strong>{belowPrice && <i>ниже на {money(listed - offer.offered_price)}</i>}</div>}<div className="agent-offer-actions"><button disabled={acting} onClick={() => void replyAboutAvailability(offer)} type="button">Ответить о наличии</button>{!offer.order && offer.offered_price !== undefined && <button disabled={acting} onClick={() => void requestOrderForOffer(offer)} type="button">Попросить создать заказ</button>}{offer.order?.status === "CREATED" && <button disabled={acting} onClick={() => void reserveAgentOffer(offer)} type="button">Поставить в резерв</button>}{offer.order?.status === "ACCEPTED" && <button disabled={acting} onClick={() => void approveAgentOffer(offer)} type="button">Разрешить продажу</button>}{offer.order && ["CREATED", "ACCEPTED"].includes(offer.order.status) && <button className="danger-action" disabled={acting} onClick={() => void declineAgentOffer(offer)} type="button">Отказать</button>}</div></article>; })}</div><p className="agent-order-note">Временный режим: предложенная цена фиксируется в сообщениях. MCP-заказ по-прежнему хранит цену объявления.</p></div>}
        {agentRelistCandidates.length > 0 && <div className="agent-results"><div className="agent-results-head"><strong>К перепродаже с наценкой 15%</strong><span>{agentRelistCandidates.length}</span></div><div className="agent-product-strip">{agentRelistCandidates.map((product) => <article className="agent-product-card" key={product.id}><div className={`agent-product-image category-${product.category}`}>{product.image ? <img src={product.image} alt="" /> : <span>{categoryNames[product.category] || "Товар"}</span>}<i>Куплено</i></div><div><small>{categoryNames[product.category] || product.category}</small><h3>{product.title}</h3><strong>{money(Math.round(Number(product.price) * 1.15 * 100) / 100)}</strong><div className="agent-card-actions single"><button disabled={acting} onClick={() => void relistPurchasedProduct(product)} type="button">Выставить на продажу</button></div></div></article>)}</div></div>}
        {agentSortedOrders.length > 0 && <div className="agent-results"><div className="agent-results-head"><strong>Входящие заказы</strong><span>{agentSortedOrders.length}</span></div><div className="agent-order-list">{agentSortedOrders.map((order) => <article className={order.id === bestAgentOrderId ? "agent-order recommended" : "agent-order"} key={order.id}><div>{order.id === bestAgentOrderId && <span className="agent-recommendation">Рекомендация агента</span>}<strong>{order.product?.title || `Заказ ${order.id.slice(0, 8)}`}</strong><small>{statusNames[order.status] || order.status} · {shortDate(order.created_at)}</small></div><div><strong>{order.product ? money(order.product.price) : "Цена объявления"}</strong>{order.status === "CREATED" && <button disabled={acting} onClick={() => void acceptAgentOrder(order)} type="button">Подтвердить</button>}</div></article>)}</div><p className="agent-order-note">MCP не хранит отдельную цену предложения: сравнение выполняется по цене объявления. При равенстве агент не обещает несуществующую выгоду.</p></div>}
        <form className="agent-composer" onSubmit={submitAgentTask}><textarea aria-label="Задача агенту" disabled={agentSending} enterKeyHint="send" name="agent_task" required maxLength={4000} placeholder="Например: найди городской велосипед до 35 000 ₽…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.currentTarget.value.trim()) event.currentTarget.form?.requestSubmit(); } }} /><button disabled={agentSending} type="submit">{agentSending ? "Думаю…" : "Отправить ↗"}</button></form>
      </section>
    </div></Modal>}

    {panel === "product" && selected && <Modal eyebrow={categoryNames[selected.category] || "Объявление"} title={selected.title} wide close={() => setPanel(null)}>
      <div className="product-detail"><div className={`detail-image category-${selected.category}`}>{selected.image ? <img src={selected.image} alt={selected.title} /> : <span>{categoryNames[selected.category] || "Находка"}</span>}</div><div className="detail-copy"><span className="status-badge status-active">{statusNames[selected.status || "ACTIVE"]}</span><strong className="detail-price">{money(selected.price)}</strong><p>{selected.description || "Продавец пока не добавил описание."}</p><small>Объявление · {selected.id.slice(0, 8)}</small><div className="detail-actions"><button className="submit-action" disabled={acting} onClick={() => void createOrder(selected)} type="button">Создать заказ</button><button className="secondary-action" onClick={() => document.getElementById("deal-chat")?.focus()} type="button">Написать продавцу</button></div></div></div>
      <section className="blockchain-deal"><div className="deal-title"><div><span className="deal-lock" aria-hidden="true">◆</span><div><small>Защищённая тестовая сделка</small><h3>Оплата в блокчейне</h3></div></div><span className="deal-test-badge">Testnet</span></div>
        {actionError && <p className="inline-error">{actionError}</p>}
        <div className="deal-layout"><div className="deal-settlement"><div className="deal-panel-head"><div><strong>Реквизиты сделки</strong><span>Публичные данные Sepolia</span></div><i aria-hidden="true">◇</i></div>{dealPayment ? <><dl className="deal-details"><div><dt>Номер счёта</dt><dd><code>{dealPayment.address}</code><a href={dealPayment.explorer_url} target="_blank" rel="noreferrer">↗</a></dd></div><div><dt>Валюта</dt><dd>{dealPayment.currency}</dd></div><div><dt>Сеть</dt><dd>{dealPayment.network}<span>Chain ID {dealPayment.chain_id}</span></dd></div><div><dt>Тестовая сумма</dt><dd>{dealPayment.amount_eth} ETH</dd></div></dl><div className="deal-buttons"><a className="deal-check-account" href={dealPayment.explorer_url} target="_blank" rel="noreferrer">Проверить счёт ↗</a><button disabled={paymentSending} onClick={() => void sendSepoliaPayment(dealPayment, "deal")} type="button">{paymentSending ? "Откройте кошелёк…" : "Оплатить тестовым ETH"}</button></div><form className="deal-verify" onSubmit={verifyDealTransaction}><label>Хэш транзакции<input name="transaction_hash" required pattern="^0x[0-9a-fA-F]{64}$" placeholder="0x…" /></label><button disabled={dealLoading} type="submit">{dealLoading ? "Проверяем…" : "Проверить сделку"}</button></form>{dealPayment.transaction && <div className={`deal-transaction status-${dealPayment.transaction.status}`}><strong>{dealPayment.transaction.status === "confirmed" ? dealPayment.transaction.finalized ? "Транзакция финализирована" : "Подтверждена, ждём финализации" : dealPayment.transaction.status === "pending" ? "Транзакция ожидает подтверждения" : dealPayment.transaction.status === "failed" ? "Транзакция завершилась ошибкой" : "Транзакция не найдена"}</strong><span>{dealPayment.transaction.recipient_matches ? "Получатель совпадает" : "Получатель не совпадает"}{dealPayment.transaction.block_number ? ` · блок ${dealPayment.transaction.block_number}` : ""}</span><a href={dealPayment.transaction.explorer_url} target="_blank" rel="noreferrer">Открыть в Etherscan ↗</a></div>}</> : <p className="deal-placeholder">Реквизиты временно недоступны.</p>}</div>
          <div className="deal-chat-panel"><div className="deal-panel-head"><div><strong>Чат с продавцом</strong><span>По этому объявлению</span></div><i aria-hidden="true">●</i></div><div className="deal-message-list">{dealLoading && dealMessages.length === 0 ? <p className="deal-placeholder">Загружаем переписку…</p> : dealMessages.length === 0 ? <p className="deal-placeholder">Сообщений пока нет. Уточните детали передачи или оплаты.</p> : dealMessages.map((message) => <article className={message.sender_id === profile?.id ? "mine" : ""} key={message.id}><p>{message.text}</p><small>{shortDate(message.created_at)}</small></article>)}</div><form className="deal-message-form" onSubmit={sendDealMessage}><input id="deal-chat" name="deal_message" required maxLength={4000} placeholder="Сообщение продавцу" /><button disabled={acting} type="submit" aria-label="Отправить сообщение">↑</button></form></div></div>
      </section>
    </Modal>}

    {panel === "orders" && <Modal eyebrow="Покупки и продажи" title="Мои заказы" wide close={() => setPanel(null)}><div className="panel-tabs">{[["all","Все"],["buyer","Покупаю"],["seller","Продаю"]].map(([value,label]) => <button className={orderRole === value ? "active" : ""} key={value} onClick={() => { setOrderRole(value); void openOrders(value); }} type="button">{label}</button>)}</div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем заказы…</div> : <>{orderRole === "seller" && <section className="selling-products"><div className="subsection-heading"><div><span>Ваши объявления</span><strong>Выставлено на продажу</strong></div><span>{sellingProducts.length}</span></div>{sellingProducts.length === 0 ? <p className="subsection-empty">У вас пока нет выставленных товаров.</p> : <div className="selling-product-grid">{sellingProducts.map((product) => <article key={product.id}><button className={`selling-product-image category-${product.category}`} onClick={() => { setSelected(product); setPanel("product"); }} type="button">{product.image ? <img src={product.image} alt="" /> : categoryNames[product.category]}</button><div><span className={`status-badge status-${product.status?.toLowerCase()}`}>{statusNames[product.status || "ACTIVE"]}</span><strong>{product.title}</strong><small>{money(product.price)}</small></div><button onClick={() => void openMessages({ productId: product.id, productTitle: product.title })} type="button">Сообщения</button></article>)}</div>}</section>}{orders.length === 0 ? <EmptyState title={orderRole === "seller" ? "Входящих заказов пока нет" : "Заказов пока нет"} text={orderRole === "seller" ? "Ваши выставленные товары показаны выше. Новые предложения появятся здесь." : "Откройте понравившееся объявление и создайте заказ."} /> : <div className="order-list">{orders.map((order) => <article key={order.id}><div><span className={`status-badge status-${order.status.toLowerCase()}`}>{statusNames[order.status] || order.status}</span><h3>{order.product?.title || `Заказ ${order.id.slice(0, 8)}`}</h3><p>{shortDate(order.created_at)}</p></div><div className="item-actions">{order.status === "CREATED" && order.seller_id === profile?.id && <button disabled={acting} onClick={() => void changeOrder(order,"accept_order")} type="button">Подтвердить</button>}{order.status === "ACCEPTED" && <button disabled={acting} onClick={() => void changeOrder(order,"complete_order")} type="button">Завершить</button>}{["CREATED","ACCEPTED"].includes(order.status) && <button className="danger-action" disabled={acting} onClick={() => void changeOrder(order,"cancel_order")} type="button">Отменить</button>}<button onClick={() => void openMessages({ productId: order.product_id || order.product?.id || "", productTitle: order.product?.title, orderId: order.id })} type="button">Сообщения</button></div></article>)}</div>}</>}</Modal>}

    {panel === "messages" && <Modal eyebrow="Личные сообщения" title={messageContext.productTitle || "Сообщения"} wide close={() => setPanel(null)}><div className="conversation-setup"><label>ID продукта<input value={messageContext.productId} placeholder="Выберите товар или вставьте ID" onChange={(event) => setMessageContext({ ...messageContext, productId: event.target.value })} /></label><button disabled={!messageContext.productId || panelLoading} onClick={() => void openMessages()} type="button">Открыть диалог</button></div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем переписку…</div> : !messageContext.productId ? <EmptyState title="Выберите объявление" text="Откройте карточку товара и нажмите «Написать продавцу» — или укажите ID продукта." /> : <><div className="message-list">{messages.length === 0 ? <EmptyState title="Диалог пока пуст" text="Начните разговор — уточните состояние или договоритесь о передаче." /> : messages.map((message) => <article className={message.sender_id === profile?.id ? "message mine" : "message"} key={message.id}><p>{message.text}</p><small>{shortDate(message.created_at)}</small></article>)}</div><form className="message-form" onSubmit={sendMessage}><textarea name="text" required maxLength={4000} placeholder="Напишите сообщение…" /><button disabled={acting} type="submit">{acting ? "…" : "Отправить ↗"}</button></form></>}</Modal>}
    <button className="floating-agent-button" style={agentButtonPosition ? { "--agent-x": `${agentButtonPosition.x}px`, "--agent-y": `${agentButtonPosition.y}px` } as CSSProperties : undefined} type="button" aria-label="Открыть агента. Кнопку можно перетащить" title="Агент — перетащите в удобное место" onPointerDown={beginAgentDrag} onPointerMove={moveAgentButton} onPointerUp={finishAgentDrag} onPointerCancel={() => { agentDrag.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPanel("agent"); setAgentError(""); } }}><span aria-hidden="true">✦</span><small>Агент</small></button>
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </main>;
}
