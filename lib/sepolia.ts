import { createWalletClient, formatEther, getAddress, http, isAddress, isHash, parseEther } from "viem";
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
    amount_eth?: string;
    block_number?: number;
    explorer_url: string;
  };
};

const chainId = 11155111 as const;
const amountEth = "0.0001";
const valueWeiHex = "0x5af3107a4000";

export type SentTestPayment = {
  hash: `0x${string}`;
  from: string;
  to: string;
  amount_eth: string;
  explorer_url: string;
};

export function getTestPaymentDetails(): PaymentDetails {
  const configured = process.env.SEPOLIA_PAYMENT_ADDRESS || "";
  if (!isAddress(configured)) throw new Error("Тестовый платёжный адрес пока не настроен");
  const address = getAddress(configured);
  return {
    network: "Ethereum Sepolia",
    chain_id: chainId,
    address,
    currency: "SepoliaETH",
    amount_eth: amountEth,
    value_wei_hex: valueWeiHex,
    explorer_url: `https://sepolia.etherscan.io/address/${address}`,
    faucet_url: "https://ethereum.org/developers/docs/networks/#sepolia",
  };
}

export async function sendTestPayment(recipientValue: unknown): Promise<SentTestPayment> {
  const recipient = typeof recipientValue === "string" ? recipientValue.trim() : "";
  if (!isAddress(recipient)) throw new Error("Продавец прислал некорректный Ethereum-адрес");
  const configuredKey = process.env.SEPOLIA_PAYMENT_PRIVATE_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(configuredKey)) throw new Error("Тестовый кошелёк покупателя не настроен");
  const account = privateKeyToAccount(configuredKey as `0x${string}`);
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const client = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  const to = getAddress(recipient);
  const hash = await client.sendTransaction({ account, chain: sepolia, to, value: parseEther(amountEth) });
  return { hash, from: account.address, to, amount_eth: amountEth, explorer_url: `https://sepolia.etherscan.io/tx/${hash}` };
}

export async function verifyTestPayment(hashValue: unknown): Promise<PaymentDetails> {
  const hash = typeof hashValue === "string" ? hashValue.trim() : "";
  if (!isHash(hash)) throw new Error("Нужен полный Ethereum-хэш вида 0x… длиной 66 символов");
  const details = getTestPaymentDetails();
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
  if (!transaction) return { ...details, transaction: { hash, status: "not_found", finalized: false, recipient_matches: false, explorer_url: explorerUrl } };
  const recipientMatches = typeof transaction.to === "string" && transaction.to.toLowerCase() === details.address.toLowerCase();
  const value = typeof transaction.value === "string" ? transaction.value : undefined;
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
      amount_eth: value ? formatEther(BigInt(value)) : undefined,
      block_number: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined,
      explorer_url: explorerUrl,
    },
  };
}
