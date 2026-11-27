/**
 * External Stripe cleanup boundary executed fail-closed prior to irreversible database deletion.
 */
export interface IStripeCustomerWithdrawalCleanupPort {
  /**
   * Cancels active subscriptions/schedules and deletes the external Stripe customer before local deletion.
   *
   * @throws Error When Stripe subscription cancellation or customer deletion fails.
   */
  cancelAndDeleteCustomer(stripeCustomerId: string): Promise<void>;
}
