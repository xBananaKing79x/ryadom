"use client";
/* eslint-disable @next/next/no-img-element -- MCP returns external image URLs at runtime. */

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Product = { id: string; seller_id?: string; title: string; description?: string; price: number | string; category: string; status?: string; created_at?: string; image?: string };
type Profile = { id: string; first_name?: string; last_name?: string; created_at?: string };
type Order = { id: string; product_id?: string; product?: Product; buyer_id?: string; seller_id?: string; status: string; created_at?: string };
type Message = { id: string; sender_id?: string; receiver_id?: string; text: string; created_at?: string; product_id?: string; order_id?: string };
type InboxMessage = Message & { product_id: string; productTitle: string };
type ImageRecord = { id?: string; url?: string; alt_text?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type Panel = "profile" | "products" | "orders" | "messages" | "product" | "create" | "edit" | null;

const categories = [
  ["", "Все", "✦"], ["electronics", "Электроника", "⌁"], ["computers", "Компьютеры", "⌘"],
  ["phones", "Телефоны", "▣"], ["gaming", "Игры", "◇"], ["transport", "Транспорт", "◉"],
  ["home", "Для дома", "⌂"], ["clothes", "Одежда", "♢"], ["other", "Другое", "+"],
] as const;
const categoryNames = Object.fromEntries(categories.map(([value, label]) => [value, label]));
const statusNames: Record<string, string> = { ACTIVE: "Активно", RESERVED: "Зарезервировано", SOLD: "Продано", REMOVED: "Снято", CREATED: "Создан", ACCEPTED: "Подтверждён", CANCELLED: "Отменён", COMPLETED: "Завершён" };

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
  const [orderRole, setOrderRole] = useState("all");
  const [selected, setSelected] = useState<Product | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inboxMessages, setInboxMessages] = useState<InboxMessage[]>([]);
  const [readMessageIds, setReadMessageIds] = useState<string[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [messageContext, setMessageContext] = useState<{ productId: string; productTitle?: string; receiverId?: string; orderId?: string }>({ productId: "" });
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);

  const hydrateImages = useCallback(async (list: Product[], target: "catalog" | "mine" = "catalog") => {
    await Promise.all(list.slice(0, 16).map(async (product) => {
      try {
        const images = await mcpCall<ImageRecord[]>("get_product_images", { product_id: product.id });
        if (!images?.[0]?.url) return;
        const patch = (current: Product[]) => current.map((item) => item.id === product.id ? { ...item, image: images[0].url } : item);
        if (target === "catalog") setProducts(patch); else setMyProducts(patch);
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
    try { const list = await mcpCall<Product[]>("get_my_products", { limit: 50 }); setMyProducts(Array.isArray(list) ? list : []); void hydrateImages(Array.isArray(list) ? list : [], "mine"); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось загрузить продукты"); } finally { setPanelLoading(false); }
  }

  async function openOrders(role = orderRole) {
    setPanel("orders"); setPanelLoading(true); setActionError("");
    try { const list = await mcpCall<Order[]>("get_my_orders", { role, limit: 50 }); setOrders(Array.isArray(list) ? list : []); }
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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const text = String(form.get("text") || "").trim(); if (!text || !messageContext.productId) return;
    setActing(true); setActionError("");
    try {
      const args: Record<string, unknown> = { product_id: messageContext.productId, text };
      if (messageContext.receiverId) args.receiver_id = messageContext.receiverId; if (messageContext.orderId) args.order_id = messageContext.orderId;
      await mcpCall("send_message", args); event.currentTarget.reset(); showToast("Сообщение отправлено"); await openMessages();
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Сообщение не отправлено"); } finally { setActing(false); }
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
    setActing(true); try { await mcpCall("remove_product", { product_id: product.id }); showToast("Объявление снято"); await openMyProducts(); }
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
      <div className="hero-copy"><p className="eyebrow">Вещи с историей — людям рядом</p><h1>Найдётся <em>рядом</em></h1><p className="hero-description">Хорошие вещи не должны лежать без дела. Покупайте, продавайте и договаривайтесь напрямую.</p></div>
      <div className="hero-art" aria-label="Подборка вещей с площадки"><div className="hero-art-image" /><span className="art-sticker">бережно<br />из рук в руки</span><span className="art-spark">✦</span></div>
    </section>

    <section className="search-zone" aria-label="Поиск объявлений">
      <div className="category-scroll">{categories.map(([value, label, icon]) => <button className={category === value ? "category-chip active" : "category-chip"} key={value || "all"} onClick={() => chooseCategory(value)} type="button"><span aria-hidden="true">{icon}</span>{label}</button>)}</div>
      <form className="search-form" onSubmit={(event) => { event.preventDefault(); void loadProducts(); }}><span className="search-icon" aria-hidden="true">⌕</span><input aria-label="Что вы ищете" onChange={(event) => setQuery(event.target.value)} placeholder="Что хотите найти?" value={query} /><button type="submit">Найти</button></form>
      <div className="filter-row">
        <div className="filter-cluster"><label>Сортировка<select value={sort} onChange={(event) => { setSort(event.target.value); void loadProducts(query, category, event.target.value); }}><option value="created_desc">Сначала новые</option><option value="price_asc">Сначала дешевле</option><option value="price_desc">Сначала дороже</option><option value="created_asc">Сначала старые</option><option disabled>По просмотрам — скоро</option></select></label><div className="price-filter"><span>Цена</span><input aria-label="Цена от" inputMode="numeric" placeholder="от" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /><input aria-label="Цена до" inputMode="numeric" placeholder="до" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /><button type="button" aria-label="Применить цену" onClick={() => void loadProducts()}>→</button></div></div>
        <button className="add-button" onClick={() => { setSelected(null); setPanel("create"); }} type="button"><span aria-hidden="true">＋</span> Добавить продукт</button>
      </div>
    </section>

    <section className="catalog" aria-labelledby="catalog-title">
      <div className="section-heading"><div><p className="eyebrow">Свежие находки</p><h2 id="catalog-title">Новое рядом с вами</h2></div>{!loading && !error && <span>{products.length} предложений</span>}</div>
      {error ? <div className="notice error"><strong>Каталог не загрузился</strong><span>{error}</span><button type="button" onClick={() => void loadProducts()}>Повторить</button></div> : loading ? <div className="product-grid" aria-label="Загрузка">{Array.from({ length: 8 }).map((_, index) => <div className="product-card skeleton" key={index} />)}</div> : products.length === 0 ? <div className="notice"><strong>Ничего не нашли</strong><span>Попробуйте изменить запрос или категорию.</span></div> : <div className="product-grid">{products.map((product) => <article className="product-card" key={product.id}><button className={`product-image category-${product.category}`} onClick={() => { setSelected(product); setPanel("product"); }} type="button">{product.image ? <img src={product.image} alt="" /> : <span>{categoryNames[product.category] || "Находка"}</span>}<i aria-hidden="true">♡</i></button><div className="product-info"><span className="product-category">{categoryNames[product.category] || product.category}</span><h3>{product.title}</h3><strong>{money(product.price)}</strong><div className="card-actions"><button className="card-link" onClick={() => { setSelected(product); setPanel("product"); }} type="button">Посмотреть <span aria-hidden="true">↗</span></button><button className="message-link" aria-label={`Написать по объявлению «${product.title}»`} onClick={() => void openMessages({ productId: product.id, productTitle: product.title })} type="button"><span aria-hidden="true">○</span> Написать</button></div></div></article>)}</div>}
    </section>

    <section className="trust-band"><div><span className="trust-number">01</span><strong>Живые объявления</strong><p>Каталог обновляется напрямую с платформы.</p></div><div><span className="trust-number">02</span><strong>Диалог до сделки</strong><p>Задайте продавцу вопросы в личных сообщениях.</p></div><div><span className="trust-number">03</span><strong>Понятный заказ</strong><p>Создайте, подтвердите или отмените сделку.</p></div></section>
    <footer><a className="brand" href="#top"><span className="brand-mark">Р</span><span>рядом</span></a><span>Вещи меняют хозяев. Город становится ближе.</span><button onClick={() => { setSelected(null); setPanel("create"); }} type="button">Разместить объявление ↗</button></footer>

    {panel === "profile" && <Modal eyebrow="Личный кабинет" title="Ваш профиль" close={() => setPanel(null)}>{panelLoading ? <div className="panel-loader">Загружаем…</div> : profile ? <div className="profile-card"><div className="avatar">{profileName.charAt(0)}</div><div><h3>{profileName}</h3><p>На «Рядом» с {shortDate(profile.created_at)}</p><small>ID · {profile.id}</small></div></div> : <EmptyState title="Профиль недоступен" text={actionError || "Попробуйте открыть его снова."} />}</Modal>}

    {panel === "products" && <Modal eyebrow="Ваши объявления" title="Мои продукты" wide close={() => setPanel(null)}><div className="panel-actions"><button className="primary-action" onClick={() => { setSelected(null); setPanel("create"); }} type="button">＋ Добавить продукт</button></div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем продукты…</div> : myProducts.length === 0 ? <EmptyState title="Пока нет объявлений" text="Первое объявление можно разместить за пару минут." action={<button className="text-action" onClick={() => setPanel("create")} type="button">Добавить продукт →</button>} /> : <div className="compact-list">{myProducts.map((product) => <article key={product.id}><div className={`compact-image category-${product.category}`}>{product.image ? <img src={product.image} alt="" /> : categoryNames[product.category]}</div><div><span className={`status-badge status-${product.status?.toLowerCase()}`}>{statusNames[product.status || ""] || product.status}</span><h3>{product.title}</h3><strong>{money(product.price)}</strong></div><div className="item-actions"><button onClick={() => { setSelected(product); setPanel("edit"); }} type="button">Редактировать</button><button className="danger-action" disabled={acting} onClick={() => void removeProduct(product)} type="button">Снять</button></div></article>)}</div>}</Modal>}

    {(panel === "create" || panel === "edit") && <Modal eyebrow={panel === "edit" ? "Редактирование" : "Новое объявление"} title={panel === "edit" ? "Обновить продукт" : "Добавить продукт"} close={() => setPanel(null)}><form className="product-form" onSubmit={createOrUpdateProduct}><label>Название<input name="title" minLength={3} maxLength={200} required defaultValue={panel === "edit" ? selected?.title : ""} placeholder="Например, торшер из дерева" /></label><label>Описание<textarea name="description" minLength={1} maxLength={5000} required defaultValue={panel === "edit" ? selected?.description : ""} placeholder="Состояние, комплект, детали передачи" /></label><div className="form-grid"><label>Цена, ₽<input name="price" type="number" min="0.01" step="0.01" required defaultValue={panel === "edit" ? String(selected?.price || "") : ""} placeholder="2500" /></label><label>Категория<select name="category" required defaultValue={panel === "edit" ? selected?.category : "home"}>{categories.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label className="file-field">Фотография<input name="image" type="file" accept="image/jpeg,image/png,image/webp" /><span>{panel === "edit" ? "Выберите новое фото, чтобы добавить его" : "JPEG, PNG или WebP"}</span></label>{actionError && <p className="inline-error">{actionError}</p>}<button className="submit-action" disabled={acting} type="submit">{acting ? "Сохраняем…" : panel === "edit" ? "Сохранить изменения" : "Опубликовать продукт"}</button></form></Modal>}

    {panel === "product" && selected && <Modal eyebrow={categoryNames[selected.category] || "Объявление"} title={selected.title} wide close={() => setPanel(null)}><div className="product-detail"><div className={`detail-image category-${selected.category}`}>{selected.image ? <img src={selected.image} alt={selected.title} /> : <span>{categoryNames[selected.category] || "Находка"}</span>}</div><div className="detail-copy"><span className="status-badge status-active">{statusNames[selected.status || "ACTIVE"]}</span><strong className="detail-price">{money(selected.price)}</strong><p>{selected.description || "Продавец пока не добавил описание."}</p><small>Объявление · {selected.id.slice(0, 8)}</small>{actionError && <p className="inline-error">{actionError}</p>}<div className="detail-actions"><button className="submit-action" disabled={acting} onClick={() => void createOrder(selected)} type="button">Создать заказ</button><button className="secondary-action" onClick={() => void openMessages({ productId: selected.id, productTitle: selected.title })} type="button">Написать продавцу</button></div></div></div></Modal>}

    {panel === "orders" && <Modal eyebrow="Покупки и продажи" title="Мои заказы" wide close={() => setPanel(null)}><div className="panel-tabs">{[["all","Все"],["buyer","Покупаю"],["seller","Продаю"]].map(([value,label]) => <button className={orderRole === value ? "active" : ""} key={value} onClick={() => { setOrderRole(value); void openOrders(value); }} type="button">{label}</button>)}</div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем заказы…</div> : orders.length === 0 ? <EmptyState title="Заказов пока нет" text="Откройте понравившееся объявление и создайте заказ." /> : <div className="order-list">{orders.map((order) => <article key={order.id}><div><span className={`status-badge status-${order.status.toLowerCase()}`}>{statusNames[order.status] || order.status}</span><h3>{order.product?.title || `Заказ ${order.id.slice(0, 8)}`}</h3><p>{shortDate(order.created_at)}</p></div><div className="item-actions">{order.status === "CREATED" && order.seller_id === profile?.id && <button disabled={acting} onClick={() => void changeOrder(order,"accept_order")} type="button">Подтвердить</button>}{order.status === "ACCEPTED" && <button disabled={acting} onClick={() => void changeOrder(order,"complete_order")} type="button">Завершить</button>}{["CREATED","ACCEPTED"].includes(order.status) && <button className="danger-action" disabled={acting} onClick={() => void changeOrder(order,"cancel_order")} type="button">Отменить</button>}<button onClick={() => void openMessages({ productId: order.product_id || order.product?.id || "", productTitle: order.product?.title, orderId: order.id })} type="button">Сообщения</button></div></article>)}</div>}</Modal>}

    {panel === "messages" && <Modal eyebrow="Личные сообщения" title={messageContext.productTitle || "Сообщения"} wide close={() => setPanel(null)}><div className="conversation-setup"><label>ID продукта<input value={messageContext.productId} placeholder="Выберите товар или вставьте ID" onChange={(event) => setMessageContext({ ...messageContext, productId: event.target.value })} /></label><button disabled={!messageContext.productId || panelLoading} onClick={() => void openMessages()} type="button">Открыть диалог</button></div>{actionError && <p className="inline-error">{actionError}</p>}{panelLoading ? <div className="panel-loader">Загружаем переписку…</div> : !messageContext.productId ? <EmptyState title="Выберите объявление" text="Откройте карточку товара и нажмите «Написать продавцу» — или укажите ID продукта." /> : <><div className="message-list">{messages.length === 0 ? <EmptyState title="Диалог пока пуст" text="Начните разговор — уточните состояние или договоритесь о передаче." /> : messages.map((message) => <article className={message.sender_id === profile?.id ? "message mine" : "message"} key={message.id}><p>{message.text}</p><small>{shortDate(message.created_at)}</small></article>)}</div><form className="message-form" onSubmit={sendMessage}><textarea name="text" required maxLength={4000} placeholder="Напишите сообщение…" /><button disabled={acting} type="submit">{acting ? "…" : "Отправить ↗"}</button></form></>}</Modal>}
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </main>;
}
