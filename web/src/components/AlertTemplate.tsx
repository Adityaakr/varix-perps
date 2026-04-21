import type { AlertTemplateProps } from "@gear-js/react-hooks";

export function AlertTemplate({ alert, close }: AlertTemplateProps) {
  return (
    <div className={`gear-alert gear-alert-${alert.options.type}`}>
      <div>
        {alert.options.title ? <strong>{alert.options.title}</strong> : null}
        <div>{alert.content}</div>
      </div>
      <button onClick={close} type="button">
        Dismiss
      </button>
    </div>
  );
}
