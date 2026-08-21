import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddress, isHash, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export type PaymentDetails = {
  network: "Ethereum Sepolia";
  chain_id: 11155111;
  address: string;
  currency: "SepoliaETH";
  amount_eth: string;
  value_wei_hex: string;
  explorer_url: string;
  faucet_url: string;
  transaction?: {
    hash: string;
    status: "pending" | "confirmed" | "failed" | "not_found";
    finalized: boolean;
    recipient_matches: boolean;
    amount_matches: boolean;
    expected_amount_eth: string;
    amount_eth?: string;
    block_number?: number;
    explorer_url: string;
  };
};

const chainId = 11155111 as const;
const amountEth = "0.0001";

export type EthRubQuote = {
  rub_amount: string;
  eth_rub_rate: string;
  amount_eth: string;
  quoted_at: string;
  source: "Coinbase spot ETH-RUB" | "configured ETH_RUB_RATE";
};

function normalizedAmount(value: unknown, fallback = amountEth) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim().replace(",", ".") : fallback;
  if (!/^\d+(?:\.\d{1,18})?$/.test(raw) || parseEther(raw) <= 0n) throw new Error("Некорректная сумма ETH");
  return raw;
}

export async function quoteRubPriceInEth(rubValue: unknown): Promise<EthRubQuote> {
  const rubAmount = Number(rubValue);
  if (!Number.isFinite(rubAmount) || rubAmount <= 0) throw new Error("Некорректная цена объявления");
  const configuredRate = Number(process.env.ETH_RUB_RATE);
  let rate = configuredRate;
  let source: EthRubQuote["source"] = "configured ETH_RUB_RATE";
  if (!Number.isFinite(rate) || rate <= 0) {
    const response = await fetch("https://api.coinbase.com/v2/prices/ETH-RUB/spot", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Не удалось получить курс ETH/RUB для сделки");
    const payload = await response.json() as { data?: { amount?: string } };
    rate = Number(payload.data?.amount);
    source = "Coinbase spot ETH-RUB";
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Сервис курса вернул некорректный ETH/RUB");
  const quotedAmount = (rubAmount / rate).toFixed(8);
  return { rub_amount: rubAmount.toFixed(2), eth_rub_rate: rate.toFixed(8), amount_eth: quotedAmount, quoted_at: new Date().toISOString(), source };
}

export type SentTestPayment = {
  hash: `0x${string}`;
  from: string;
  to: string;
  amount_eth: string;
  explorer_url: string;
};

export type PaymentTotal = {
  expected_amount_eth: string;
  total_sent_eth: string;
  total_received_eth: string;
  total_finalized_eth: string;
  remaining_amount_eth: string;
  remaining_received_eth: string;
  total_sent_matches: boolean;
  total_finalized_matches: boolean;
  has_pending: boolean;
  payments: PaymentDetails[];
};

export function getTestPaymentDetails(amountValue: unknown = amountEth): PaymentDetails {
  const configured = process.env.SEPOLIA_PAYMENT_ADDRESS || "";
  if (!isAddress(configured)) throw new Error("Тестовый платёжный адрес пока не настроен");
  const address = getAddress(configured);
  const expectedAmount = normalizedAmount(amountValue);
  return {
    network: "Ethereum Sepolia",
    chain_id: chainId,
    address,
    currency: "SepoliaETH",
    amount_eth: expectedAmount,
    value_wei_hex: `0x${parseEther(expectedAmount).toString(16)}`,
    explorer_url: `https://sepolia.etherscan.io/address/${address}`,
    faucet_url: "https://ethereum.org/developers/docs/networks/#sepolia",
  };
}

export async function sendTestPayment(recipientValue: unknown, amountValue: unknown = amountEth): Promise<SentTestPayment> {
  const recipient = typeof recipientValue === "string" ? recipientValue.trim() : "";
  if (!isAddress(recipient)) throw new Error("Продавец прислал некорректный Ethereum-адрес");
  const configuredKey = process.env.SEPOLIA_PAYMENT_PRIVATE_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(configuredKey)) throw new Error("Тестовый кошелёк покупателя не настроен");
  const account = privateKeyToAccount(configuredKey as `0x${string}`);
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const client = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const to = getAddress(recipient);
  const expectedAmount = normalizedAmount(amountValue);
  const value = parseEther(expectedAmount);
  const [balance, fees] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.estimateFeesPerGas()]);
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const gasReserve = 21_000n * gasPrice;
  if (value + gasReserve > balance) {
    const spendable = balance > gasReserve ? balance - gasReserve : 0n;
    throw new Error(`Недостаточно SepoliaETH: доступно для оплаты ${formatEther(spendable)} ETH с учётом комиссии, требуется ${expectedAmount} ETH`);
  }
  const hash = await client.sendTransaction({ account, chain: sepolia, to, value });
  return { hash, from: account.address, to, amount_eth: expectedAmount, explorer_url: `https://sepolia.etherscan.io/tx/${hash}` };
}

export async function verifyPaymentTotal(hashValues: unknown[], expected: { address?: unknown; amount_eth?: unknown }): Promise<PaymentTotal> {
  const hashes = [...new Set(hashValues.filter((value): value is string => typeof value === "string" && isHash(value)))];
  const expectedAmount = normalizedAmount(expected.amount_eth);
  const expectedWei = parseEther(expectedAmount);
  const payments = await Promise.all(hashes.map((hash) => verifyTestPayment(hash, { address: expected.address, amount_eth: "0.000000000000000001" })));
  let sentWei = 0n;
  let receivedWei = 0n;
  let finalizedWei = 0n;
  let hasPending = false;
  for (const payment of payments) {
    const transaction = payment.transaction;
    if (!transaction?.amount_eth || ["failed", "not_found"].includes(transaction.status)) continue;
    const value = parseEther(transaction.amount_eth);
    sentWei += value;
    if (transaction.recipient_matches) {
      receivedWei += value;
      if (transaction.status === "confirmed" && transaction.finalized) finalizedWei += value;
      else hasPending = true;
    }
  }
  const remainingWei = sentWei >= expectedWei ? 0n : expectedWei - sentWei;
  const remainingReceivedWei = receivedWei >= expectedWei ? 0n : expectedWei - receivedWei;
  return {
    expected_amount_eth: expectedAmount,
    total_sent_eth: formatEther(sentWei),
    total_received_eth: formatEther(receivedWei),
    total_finalized_eth: formatEther(finalizedWei),
    remaining_amount_eth: formatEther(remainingWei),
    remaining_received_eth: formatEther(remainingReceivedWei),
    total_sent_matches: sentWei >= expectedWei,
    total_finalized_matches: finalizedWei >= expectedWei,
    has_pending: hasPending,
    payments,
  };
}

export async function verifyTestPayment(hashValue: unknown, expected?: { address?: unknown; amount_eth?: unknown }): Promise<PaymentDetails> {
  const hash = typeof hashValue === "string" ? hashValue.trim() : "";
  if (!isHash(hash)) throw new Error("Нужен полный Ethereum-хэш вида 0x… длиной 66 символов");
  const details = getTestPaymentDetails(expected?.amount_eth);
  const expectedAddress = typeof expected?.address === "string" && isAddress(expected.address) ? getAddress(expected.address) : details.address;
  const expectedWei = parseEther(details.amount_eth);
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error("Не удалось связаться с сетью Sepolia");
    const payload = await response.json() as { result?: Record<string, string> | null; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message || "Sepolia RPC отклонил запрос");
    return payload.result || null;
  };
  const [transaction, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]),
    rpc("eth_getTransactionReceipt", [hash]),
  ]);
  const explorerUrl = `https://sepolia.etherscan.io/tx/${hash}`;
  if (!transaction) return { ...details, transaction: { hash, status: "not_found", finalized: false, recipient_matches: false, amount_matches: false, expected_amount_eth: details.amount_eth, explorer_url: explorerUrl } };
  const recipientMatches = typeof transaction.to === "string" && transaction.to.toLowerCase() === expectedAddress.toLowerCase();
  const value = typeof transaction.value === "string" ? transaction.value : undefined;
  const amountMatches = Boolean(value && BigInt(value) >= expectedWei);
  const status = !receipt ? "pending" : receipt.status === "0x1" ? "confirmed" : "failed";
  let finalized = false;
  if (status === "confirmed" && receipt?.blockNumber) {
    const finalizedBlock = await rpc("eth_getBlockByNumber", ["finalized", false]).catch(() => null);
    finalized = Boolean(finalizedBlock?.number && BigInt(receipt.blockNumber) <= BigInt(finalizedBlock.number));
  }
  return {
    ...details,
    transaction: {
      hash,
      status,
      finalized,
      recipient_matches: recipientMatches,
      amount_matches: amountMatches,
      expected_amount_eth: details.amount_eth,
      amount_eth: value ? formatEther(BigInt(value)) : undefined,
      block_number: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined,
      explorer_url: explorerUrl,
    },
  };
}
