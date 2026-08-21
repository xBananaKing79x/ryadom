import { formatEther, getAddress, isAddress, isHash } from "viem";

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
    recipient_matches: boolean;
    amount_eth?: string;
    block_number?: number;
    explorer_url: string;
  };
};

const chainId = 11155111 as const;
const amountEth = "0.0001";
const valueWeiHex = "0x5af3107a4000";

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

export async function verifyTestPayment(hashValue: unknown): Promise<PaymentDetails> {
  const hash = typeof hashValue === "string" ? hashValue.trim() : "";
  if (!isHash(hash)) throw new Error("Нужен полный Ethereum-хэш вида 0x… длиной 66 символов");
  const details = getTestPaymentDetails();
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const rpc = async (method: string) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [hash] }),
    });
    if (!response.ok) throw new Error("Не удалось связаться с сетью Sepolia");
    const payload = await response.json() as { result?: Record<string, string> | null; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message || "Sepolia RPC отклонил запрос");
    return payload.result || null;
  };
  const [transaction, receipt] = await Promise.all([rpc("eth_getTransactionByHash"), rpc("eth_getTransactionReceipt")]);
  const explorerUrl = `https://sepolia.etherscan.io/tx/${hash}`;
  if (!transaction) return { ...details, transaction: { hash, status: "not_found", recipient_matches: false, explorer_url: explorerUrl } };
  const recipientMatches = typeof transaction.to === "string" && transaction.to.toLowerCase() === details.address.toLowerCase();
  const value = typeof transaction.value === "string" ? transaction.value : undefined;
  const status = !receipt ? "pending" : receipt.status === "0x1" ? "confirmed" : "failed";
  return {
    ...details,
    transaction: {
      hash,
      status,
      recipient_matches: recipientMatches,
      amount_eth: value ? formatEther(BigInt(value)) : undefined,
      block_number: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined,
      explorer_url: explorerUrl,
    },
  };
}
