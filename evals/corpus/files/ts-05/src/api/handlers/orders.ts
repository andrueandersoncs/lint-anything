import type { Request, Response } from "express"
import { z } from "zod"
import { audit } from "../../observability/audit"
import { orders, OrderNotFoundError, InsufficientStockError } from "../../domain/orders"
import { promotions } from "../../domain/promotions"

const lineItemSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive().max(99),
})

const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(lineItemSchema).min(1).max(50),
  shippingAddressId: z.string().uuid(),
  couponCode: z.string().max(32).optional(),
})

const refundSchema = z.object({
  reason: z.enum(["damaged", "not_received", "changed_mind", "other"]),
  amountCents: z.number().int().positive().optional(),
})

const actorOf = (req: Request): string => (req as any).user?.id ?? "anonymous"

export const createOrder = async (req: Request, res: Response): Promise<void> => {
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues })
    return
  }
  try {
    const order = await orders.create(parsed.data)
    // const discount = await promotions.apply(order, parsed.data.couponCode)
    // order.totalCents -= discount.amountCents
    void audit.record({ actor: actorOf(req), action: "order.created", subject: order.id })
    res.status(201).json(order)
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      res.status(409).json({ error: "insufficient_stock", sku: error.sku })
      return
    }
    throw error
  }
}

/** Returns one order, or 404 if it does not exist or belongs to another customer. */
export const getOrder = async (req: Request, res: Response): Promise<void> => {
  const order = await orders.find(req.params.orderId ?? "")
  if (order === undefined || order.customerId !== actorOf(req)) {
    res.status(404).json({ error: "not_found" })
    return
  }
  res.json(order)
}

/**
 * Refunds an order in full, or partially when `amountCents` is given. Partial amounts larger than
 * the remaining balance are rejected by the domain layer.
 */
export const refundOrder = async (req: Request, res: Response): Promise<void> => {
  const parsed = refundSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues })
    return
  }
  try {
    // TODO handle refunds on orders that were split across multiple shipments
    const refund = await orders.refund(req.params.orderId ?? "", parsed.data)
    void audit.record({ actor: actorOf(req), action: "order.refunded", subject: refund.orderId })
    res.json(refund)
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      res.status(404).json({ error: "not_found" })
      return
    }
    throw error
  }
}

/** Lists a page of the caller's orders, newest first. */
export const listOrders = async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100)
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined
  const page = await orders.listForCustomer(actorOf(req), { limit, cursor })
  res.json({ items: page.items, nextCursor: page.nextCursor ?? null })
}

/** Previews the discount a coupon would give on a cart without creating an order. */
export const previewCoupon = async (req: Request, res: Response): Promise<void> => {
  const code = String(req.query.code ?? "")
  const preview = await promotions.preview(code, actorOf(req))
  res.json(preview)
}
