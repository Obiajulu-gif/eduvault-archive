import React, { useState, useRef, useEffect } from 'react';
import './FARSection.css';

// Sample FAQ data – replace with real content later
const FAQ_DATA = [
  {
    question: 'What is Soroban?',
    answer: 'Soroban is a smart-contract platform built on the Stellar network, enabling fast, low-cost transactions.'
  },
  {
    question: 'How do I connect my Web3 wallet?',
    answer: 'Use the "Connect Wallet" button in the header. The app currently supports any wallet that implements the EIP-1193 provider interface.'
  },
  {
    question: 'Is my file encrypted?',
    answer: 'All uploaded files are encrypted client-side with AES-256 before they ever touch the server.'
  },
  {
    question: 'Can I search my FAQs?',
    answer: 'Yes – your search bar filters questions in real-time as you type.'
  }
];

/**
 * FAQSection – an interactive, accessible FAQ ? Help Center component.
 *
 * Features:
 * • Accessible accordion widgets (button + aria attributes)
 * • Smooth rotation of the chevron icon on expand/collapse
 * • Instant client-side search filtering
 * • Micro-animations for accordion content (height & opacity)
 * • Keyboard navigation (Arrow Up/Down, Home, End) between questions
 * • Announces filter results to screen readers via aria-live
 * • Restores focus to the corresponding question after expand/collapse
 */
export default function FAQSection() {
  const [searchTerm, setSearchTerm] = useState('');
  const [openIndex, setOpenIndex] = useState(null);
  const buttonRefq = useRef([]);
  const searchInputRef = useRef(null);

  const filteredFaq = FAQ_DATA.filter(item =>
    item.question.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Reset the open panel when the filtered list changes so we don't
  // leave a stale aria-expanded on a hidden item.
  useEffect(() => {
    setOpenIndex(null);
  }, [searchTerm]);

  const toggle = index => {
    setOpenIndex(prev => (prev === index ? null : index));
  };

  // Roving tabindex so the accordion behaves like a single tabstop
  // (ARIA authoring practices) while still allowing Tab to move out.
  const handleKeyDown = (event, index) => {
    const last = filteredFaq.length - 1;
    let nextIndex = null;
    if (event.key === 'ArrowDown') nextIndex = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowUp') nextIndex = index === 0 ? last : index - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = last;
    if (nextIndex !== null && buttonRefs.current[nextIndex]) {
      event.preventDefault();
      buttonRefs.current[nextIndex].focus();
    }
  };

  const handleSearchKeyDown = event => {
    if (event.key === 'Escape' && searchTerm) {
      event.preventDefault();
      setSearchTerm('');
    }
  };

  const noResults = filteredFaq.length === 0;

  return (
    <section className="faq-section" aria-labelledby="faq-heading">
      <h2 id="faq-heading" className="faq-title">Frequently Asked Questions</h2>
      <label className="faq-search-label" htmlFor="faq-search-input">
        Search FAQs
      </label>
      <input
        id="faq-search-input"
        ref={searchInputRef}
        type="search"
        placeholder="Search…"
        className="faq-search"
        value={searchTerm}
        onChange={e => setSearchTerm(e.target.value)}
        onKeyDown={handleSearchKeyDown}
        aria-describedby="faq-search-help"
      />
      <p id="faq-search-help" className="faq-search-help">
        Type to filter questions. Press Escape to clear the field.
      </p>
      <p className="faq-sr-status" role="status" aria-live="polite">
        {noResults
          ? 'No matching questions found.'
          : `${filteredFaq.length} question${filteredFaq.length === 1 ? '' : 's'} match your search.`}
      </p>
      <div className="faq-list" role="list">
        {filteredFaq.map((item, idx) => {
          const isOpen = openIndex === idx;
          const questionId = `faq-question-${idx}`;
          const answerId = `faq-answer-${idx}`;
          return (
            <div key={idx} className="faq-item" role="listitem">
              <button
                id={questionId}
                ref={node => { buttonRefs.current[idx] = node; }}
                className="faq-question"
                type="button"
                onClick={() => toggle(idx)}
                onKeyDown={e => handleKeyDown(e, idx)}
                aria-expanded={isOpen}
                aria-controls={answerId}
                tabIndex={idx === 0 || isOpen ? 0 : -1}
              >
                <span>{item.question}</span>
                <span
                  className={`chevron ${isOpen ? 'rotated' : ''}`}
                  aria-hidden="true"
                >▼</span>
              </button>
              <div
                id={answerId}
                className={`lfaq-answer ${isOpen ? 'open' : ''}`}
                role="region"
                aria-labelledby={questionId}
                hidden={!isOpen}
              >
                <p>{item.answer}</p>
              </div>
            </div>
          );
        })}
        {noResults && (
          <p className="no-results">No matching questions found.</p>
        )}
      </div>
    </section>
  );
}
