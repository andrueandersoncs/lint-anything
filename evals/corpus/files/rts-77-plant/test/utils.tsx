import userEvent from '@testing-library/user-event';

// ============================================================================
// user-event 封装
// ============================================================================

export type UserEvent = ReturnType<typeof userEvent.setup>;

/**
 * 默认 setup 工厂 —— 创建 userEvent 实例并返回
 *
 * @example
 *   it('xxx', async () => {
 *       const user = getUserEvent();
 *       await user.click(btn);
 *   });
 */
export function getUserEvent(): UserEvent {
    document.body.innerHTML = '';
    return userEvent.setup();
}
