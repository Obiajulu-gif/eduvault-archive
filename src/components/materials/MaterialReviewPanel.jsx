"use client";

import { useMemo, useState } from "react";
import { FaCheckCircle, FaRegStar, FaShieldAlt, FaStar } from "react-icons/fa";
import { useMaterialFeedback, useSubmitMaterialFeedback } from "@/hooks/api/useMaterials";
import { formatAddress } from "@/utils/formatAddress";

const MIN_COMMENT_LENGTH = 12;
const MAX_COMMENT_LENGTH = 600;
const DEFAULT_REVIEWS = [];

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeReview(review, index) {
  return {
    id: review.id || review._id || `review-${index}`,
    rating: Number(review.score ?? review.rating) || 0,
    comment: review.comment || review.body || "",
    reviewer: review.reviewer || review.reviewerAddress || review.walletAddress || "Anonymous",
    reviewerName: review.reviewerName || review.name || "",
    verifiedBuyer: Boolean(review.verifiedBuyer || review.verified || review.hasVerifiedPurchase),
    moderationStatus: review.moderationStatus || "pending_review",
    createdAt: review.createdAt || review.date || new Date().toISOString(),
  };
}

function getReviewGateState({ currentAddress, isCreator, isSubmitting }) {
  if (!currentAddress) {
    return { canSubmit: false, status: "wallet-missing" };
  }

  if (isCreator) {
    return { canSubmit: false, status: "creator" };
  }

  if (isSubmitting) {
    return { canSubmit: false, status: "submitting" };
  }

  return { canSubmit: true, status: "ready" };
}

function RatingStars({ value, onChange, disabled = false, describedBy }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-describedby={describedBy}>
      {[1, 2, 3, 4, 5].map((star) => {
        const selected = value === star;
        const filled = star <= value;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            disabled={disabled}
            onClick={() => onChange(star)}
            className="min-h-11 min-w-11 rounded-full border border-amber-100 bg-amber-50 text-xl text-amber-500 transition hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {filled ? <FaStar className="mx-auto" /> : <FaRegStar className="mx-auto" />}
          </button>
        );
      })}
    </div>
  );
}

function SummaryStars({ rating }) {
  const normalizedRating = Number(rating) || 0;
  const rounded = Math.round(normalizedRating);
  return (
    <div className="flex items-center gap-1 text-amber-500" aria-label={`${normalizedRating.toFixed(1)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <FaStar key={star} className={star <= rounded ? "opacity-100" : "opacity-25"} />
      ))}
    </div>
  );
}

function FeedbackGateNotice({ state }) {
  const messages = {
    "wallet-missing": "Connect a wallet to leave feedback for this resource.",
    creator: "Creators cannot score their own resource.",
    submitting: "Publishing your feedback now.",
    ready: "Your feedback helps learners discover the right material faster.",
  };

  const tone = state.status === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-600";

  return <p className={`rounded-xl border px-4 py-3 text-sm ${tone}`}>{messages[state.status]}</p>;
}

function ModerationNotice({ moderation }) {
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
      <div className="flex items-start gap-2">
        <FaShieldAlt className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">{moderation?.label || "Basic moderation placeholder"}</p>
          <p className="mt-1">{moderation?.message || "Feedback is published immediately and queued for future moderation review."}</p>
        </div>
      </div>
    </div>
  );
}

export function MaterialReviewPanelView({
  materialId,
  initialReviews = DEFAULT_REVIEWS,
  feedbackData,
  feedbackLoading = false,
  submitFeedback,
  submitError,
  isSubmitting = false,
  currentAddress,
  creatorAddress,
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState({});
  const [successMessage, setSuccessMessage] = useState("");

  const reviews = useMemo(() => {
    const source = Array.isArray(feedbackData?.items) ? feedbackData.items : initialReviews;
    return source.map(normalizeReview);
  }, [feedbackData?.items, initialReviews]);

  const isCreator = normalizeAddress(currentAddress) && normalizeAddress(currentAddress) === normalizeAddress(creatorAddress);
  const gateState = getReviewGateState({ currentAddress, isCreator, isSubmitting });
  const averageRating = Number(feedbackData?.averageScore) || (
    reviews.length === 0 ? 0 : reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
  );
  const feedbackCount = Number(feedbackData?.feedbackCount ?? reviews.length) || 0;

  function validate() {
    const nextErrors = {};
    const trimmed = comment.trim();
    if (rating < 1 || rating > 5) {
      nextErrors.rating = "Choose a rating from 1 to 5 stars.";
    }
    if (!trimmed) {
      nextErrors.comment = "Write a short feedback note before publishing.";
    } else if (trimmed.length < MIN_COMMENT_LENGTH) {
      nextErrors.comment = `Feedback must be at least ${MIN_COMMENT_LENGTH} characters.`;
    } else if (trimmed.length > MAX_COMMENT_LENGTH) {
      nextErrors.comment = `Feedback must be ${MAX_COMMENT_LENGTH} characters or fewer.`;
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSuccessMessage("");

    if (!gateState.canSubmit) {
      setErrors({ form: gateState.status === "creator" ? "Creators cannot score their own resource." : "Connect a wallet before publishing feedback." });
      return;
    }

    if (!validate()) return;

    try {
      await submitFeedback({ score: rating, comment: comment.trim() });
      setRating(0);
      setComment("");
      setErrors({});
      setSuccessMessage("Feedback published and queued for moderation review.");
    } catch (error) {
      setErrors({ form: error?.message || "Unable to publish feedback right now." });
    }
  }

  return (
    <section className="mt-10 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-7" aria-labelledby="material-feedback-heading">
      <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Learner feedback</p>
          <h2 id="material-feedback-heading" className="mt-2 text-2xl font-bold text-slate-950">
            Resource ratings
          </h2>
          <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-5">
            <div className="flex items-end gap-3">
              <span className="text-4xl font-bold text-slate-950">{averageRating ? averageRating.toFixed(1) : "0.0"}</span>
              <span className="pb-1 text-sm text-slate-500">/ 5</span>
            </div>
            <div className="mt-3">
              <SummaryStars rating={averageRating} />
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {feedbackCount === 0 ? "No feedback yet" : `${feedbackCount} feedback score${feedbackCount === 1 ? "" : "s"}`}
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-5">
            <FeedbackGateNotice state={gateState} />
            <ModerationNotice moderation={feedbackData?.moderation} />
            {(errors.form || submitError) && (
              <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errors.form || submitError?.message || "Unable to publish feedback right now."}
              </p>
            )}

            <div>
              <label className="mb-3 block text-sm font-semibold text-slate-800">Score</label>
              <RatingStars
                value={rating}
                onChange={(nextRating) => {
                  setRating(nextRating);
                  setErrors((current) => ({ ...current, rating: undefined, form: undefined }));
                }}
                disabled={!gateState.canSubmit}
                describedBy={errors.rating ? "feedback-rating-error" : undefined}
              />
              {errors.rating && (
                <p id="feedback-rating-error" role="alert" className="mt-2 text-sm text-red-600">
                  {errors.rating}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="feedback-comment" className="mb-2 block text-sm font-semibold text-slate-800">
                Feedback
              </label>
              <textarea
                id="feedback-comment"
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  setErrors((current) => ({ ...current, comment: undefined, form: undefined }));
                }}
                disabled={!gateState.canSubmit}
                rows={5}
                maxLength={MAX_COMMENT_LENGTH}
                aria-invalid={Boolean(errors.comment)}
                aria-describedby={errors.comment ? "feedback-comment-error" : "feedback-comment-help"}
                className="w-full resize-y rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                placeholder="Share what helped, what could be clearer, and who this material is best for."
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                {errors.comment ? (
                  <p id="feedback-comment-error" role="alert" className="text-sm text-red-600">
                    {errors.comment}
                  </p>
                ) : (
                  <p id="feedback-comment-help" className="text-sm text-slate-500">
                    {MIN_COMMENT_LENGTH}-{MAX_COMMENT_LENGTH} characters
                  </p>
                )}
                <span className="text-xs text-slate-400">{comment.length}/{MAX_COMMENT_LENGTH}</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={!gateState.canSubmit}
              className="min-h-11 w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isSubmitting ? "Publishing feedback..." : "Publish feedback"}
            </button>
            {successMessage && (
              <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </p>
            )}
          </form>
        </div>

        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-950">Feedback history</h3>
          {feedbackLoading ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-5 py-10 text-center">
              <p className="font-semibold text-slate-800">Loading feedback...</p>
            </div>
          ) : reviews.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center">
              <p className="font-semibold text-slate-800">No feedback has been published yet.</p>
              <p className="mt-2 text-sm text-slate-500">Learners can add the first score from this resource page.</p>
            </div>
          ) : (
            <ol className="mt-5 space-y-5">
              {reviews.map((review) => (
                <li key={review.id} className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {review.reviewerName || formatAddress(review.reviewer, 8, 6) || "Anonymous"}
                      </p>
                      <p className="text-xs text-slate-500">
                        {new Date(review.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                      <FaShieldAlt aria-hidden="true" />
                      {review.moderationStatus === "pending_review" ? "Queued review" : "Moderated"}
                    </span>
                  </div>
                  <div className="mt-3">
                    <SummaryStars rating={review.rating} />
                  </div>
                  <p className="mt-3 overflow-wrap-anywhere break-words text-sm leading-6 text-slate-700">
                    {review.comment}
                  </p>
                  {review.verifiedBuyer && (
                    <span className="mt-4 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      <FaCheckCircle aria-hidden="true" />
                      Verified buyer
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Skeleton placeholder for the review panel, mirroring its two-column layout
 * so there is no layout shift once the panel resolves. Rendered as the
 * Suspense fallback while the feedback query is pending.
 */
export function MaterialReviewPanelSkeleton() {
  return (
    <section
      role="status"
      aria-label="Loading reviews"
      data-testid="material-review-skeleton"
      className="mt-10 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-7"
    >
      <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
          <div className="mt-3 h-7 w-48 rounded bg-slate-200 animate-pulse" />
          <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-5">
            <div className="h-10 w-24 rounded bg-slate-200 animate-pulse" />
            <div className="mt-3 h-4 w-40 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="mt-6 space-y-4">
            <div className="h-20 rounded-2xl bg-slate-100 animate-pulse" />
            <div className="h-28 rounded-2xl bg-slate-100 animate-pulse" />
            <div className="h-11 w-full rounded-2xl bg-slate-200 animate-pulse" />
          </div>
        </div>
        <div className="min-w-0">
          <div className="h-5 w-40 rounded bg-slate-200 animate-pulse" />
          <div className="mt-5 space-y-5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="h-4 w-32 rounded bg-slate-100 animate-pulse" />
                  <div className="h-5 w-24 rounded-full bg-slate-100 animate-pulse" />
                </div>
                <div className="mt-3 h-4 w-28 rounded bg-slate-100 animate-pulse" />
                <div className="mt-3 h-4 w-full rounded bg-slate-100 animate-pulse" />
                <div className="mt-2 h-4 w-3/4 rounded bg-slate-100 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function MaterialReviewPanel(props) {
  const feedbackQuery = useMaterialFeedback(props.materialId, { suspense: true });
  const submitFeedbackMutation = useSubmitMaterialFeedback(props.materialId);

  return (
    <MaterialReviewPanelView
      {...props}
      feedbackData={feedbackQuery.data}
      feedbackLoading={feedbackQuery.isLoading && !feedbackQuery.data}
      submitFeedback={(payload) => submitFeedbackMutation.mutateAsync(payload)}
      submitError={submitFeedbackMutation.error}
      isSubmitting={submitFeedbackMutation.isPending}
    />
  );
}
