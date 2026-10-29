import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callerWantsToEnd, detectQualitySignals, hasContactDetails } from '../quality'

test('flags runs that promise or claim actions they never took', () => {
  // The real 13 Oct case: a qualification summary ending in a promise, with only a CRM search.
  const read = [{ toolName: 'hubspot-crm__search_contacts', status: 'simulated' }]
  assert.deepEqual(detectQualitySignals("Maria fits our ICP. Now I'll draft a personalized follow-up email for your approval.", read), ['announced_without_action'])
  assert.deepEqual(detectQualitySignals('I have sent Maria a follow-up email.', read), ['claimed_without_evidence'])
  // A conversational agent may end on a question; a promise it can't keep is still flagged.
  assert.deepEqual(detectQualitySignals('I have Tuesday at 10am or Wednesday at 2pm. Which one suits you?', read, { conversational: true }), [])
  assert.deepEqual(detectQualitySignals('I have Tuesday at 10am or Wednesday at 2pm. Which one suits you?', read), ['asked_in_text'])
  assert.deepEqual(detectQualitySignals("I've booked you in for Tuesday at 10am. Anything else?", read, { conversational: true }), ['claimed_without_evidence'])
  assert.deepEqual(detectQualitySignals("I've updated the CRM and I will send a reply tomorrow.", []), ['announced_without_action', 'claimed_without_evidence'])
})

test('flags questions asked in the answer instead of with the clarification tool', () => {
  assert.deepEqual(detectQualitySignals('I need a few details. 1. What is Tom Lee\'s email address? 2. Has he been contacted before?', []), ['asked_in_text'])
  assert.deepEqual(detectQualitySignals('Is Harbour Dental a good fit, or should I pass on this lead?', []), ['asked_in_text'])
  assert.deepEqual(detectQualitySignals('Done. The contact is created and the welcome email is waiting for approval.', [{ toolName: 'gmail__send_email', status: 'approval_required' }]), [])
})

test('no signal when the action was taken or put up for approval, or nothing was promised', () => {
  const sent = [{ toolName: 'gmail__send_email', status: 'approval_required' }]
  assert.deepEqual(detectQualitySignals("I'll send this once you approve it.", sent), [])
  assert.deepEqual(detectQualitySignals('Who knows? The data says Maria fits our profile well.', []), [], 'a rhetorical question mid-answer is not a request')
  assert.deepEqual(detectQualitySignals('Maria is a good fit: 340 staff, B2B SaaS.', []), [])
  assert.deepEqual(detectQualitySignals('', []), [])
  // A platform tool (hand-off) is not an action on the outside world; promising an email still counts.
  assert.deepEqual(detectQualitySignals("I'll email her after the team replies.", [{ toolName: 'platform__suggest_improvement', status: 'completed' }]), ['announced_without_action'])
})

test('the caller ending the call: goodbyes and "that\'s all", not a question in the same breath', () => {
  // What the caller said on 26 Oct while Ava kept handing over instead of ending the call.
  for (const said of ['Okay, that’s all.', "No, I'm saying like goodbye, like that's all I need.", "I'm saying I would like you to end the call.", 'Thanks, bye!', "No, that's everything, thanks.", "I'm all good, thanks."]) {
    assert.equal(callerWantsToEnd(said), true, said)
  }
  for (const said of ["That's all good, but what about Saturdays?", 'Is that all it includes?', 'Can you tell me about SEO?', "That's it? What about ads?", 'I said goodbye to my old agency last year, so how do we start?']) {
    assert.equal(callerWantsToEnd(said), false, said)
  }
})

test('contact details: an email or a phone number, not prices, dates or package names', () => {
  for (const text of ['sam@acme.com.au', 'call me on 0412 345 678', '+61 2 9876 5432', '(02) 9876-5432']) assert.equal(hasContactDetails(text), true, text)
  for (const text of ['Growth is $7,500 a month', 'Enterprise at $15,000', 'by 26 October 2026', 'I want a custom package', 'we have 25 staff']) assert.equal(hasContactDetails(text), false, text)
})
