# Agent System Specification

## Agent philosophy

The platform creates business-specific AI employees.

An agent should know:
1. who it works for
2. what the business does
3. what its job is
4. what it is allowed to do
5. what it is not allowed to do
6. what tools it can use
7. when it must ask for approval
8. when it must escalate
9. how success is measured

## Agent context hierarchy

Use a predictable hierarchy:

1. platform safety/policy
2. tenant security policy
3. agent role
4. customer business context
5. skill instructions
6. workflow-specific instructions
7. task input
8. retrieved knowledge

Lower-level context must not override higher-level safety/policy.

## Customer-specific configuration

Represent separately:
- business profile
- objectives
- terminology
- tone
- policies
- SOPs
- examples
- users/roles
- tools
- permissions
- workflows
- escalation contacts

## Skills

Skills are reusable and versioned.

A skill should be independently testable.

Example skill:

name: lead_follow_up

Purpose:
Follow up with qualified leads according to the customer's approved process.

Inputs:
- lead
- history
- company context

Tools:
- CRM
- email

Rules:
- never invent pricing
- never make commitments outside approved policy
- escalate uncertain requests
- log every outbound action

Outputs:
- action taken
- CRM update
- next follow-up date
- escalation if required

## Memory

Separate:
- durable business knowledge
- workflow state
- task history
- transient context

Never treat raw conversation history as the entire memory architecture.

## Tool use

Before taking an external action:
1. identify requested action
2. check tool permission
3. check approval policy
4. validate inputs
5. execute
6. verify result
7. log result
8. handle failure

## Autonomous changes

Agents may propose code/config changes but production changes should go through controlled deployment.

## Self-improvement

"Gets better every week" should mean:
- new knowledge
- improved skills
- updated workflows
- regression-tested improvements
- operator/customer feedback

Do not allow uncontrolled self-modifying production behaviour.

## Agent-to-agent

Support optional supervisor/sub-agent architecture.

Example:
Operator Agent
  -> Research Agent
  -> CRM Agent
  -> Reporting Agent

Use this only where it improves reliability or maintainability.

## Human escalation

Agent should escalate when:
- confidence is low
- policy is ambiguous
- high-risk action is requested
- required information is missing
- tool failures persist
- customer-defined escalation rule triggers
