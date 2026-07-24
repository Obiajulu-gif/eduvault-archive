import { getMongoClientPromise } from '@/lib/mongodb';
import logger from '@/lib/logger';
import { auditLog } from '@/lib/api/audit';

export async function verifyRefundLimit(transactionId, refundAmount) {
  const dbClient = await getMongoClientPromise();
  const db = dbClient.db();
  const purchases = db.collection('purchases');

  const purchase = await purchases.findOne({ transactionHash: transactionId });

  if (!purchase) {
    logger.warn({ transactionId, refundAmount }, 'Refund requested for unknown transaction');
    auditLog({ event: 'refund_rejected_not_found', reason: 'Transaction not found', transactionId, refundAmount, status: 'rejected' });
    return {
      valid: false,
      reason: 'Transaction not found'
    };
  }

  const paidAmount = parseFloat(purchase.amount);
  const claimAmount = parseFloat(refundAmount);

  if (isNaN(paidAmount) || isNaN(claimAmount)) {
    return {
      valid: false,
      reason: 'Invalid amount formats'
    };
  }

  if (claimAmount > paidAmount) {
    logger.warn(
      { transactionId, paidAmount, claimAmount },
      'Refund claim exceeds original purchase amount'
    );
    auditLog({ event: 'refund_rejected_limit_exceeded', reason: 'Amount exceeds paid', transactionId, paidAmount, claimAmount, status: 'rejected' });
    
    return {
      valid: false,
      reason: 'Refund amount exceeds original purchase value'
    };
  }

  return {
    valid: true,
    purchase
  };
}
