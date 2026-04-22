import type { AlertTemplateProps } from "@gear-js/react-hooks";

export function AlertTemplate({ alert, close }: AlertTemplateProps) {
  return (
    <div className={`gear-alert gear-alert-${alert.options.type}`}>
      <div className="gear-alert-copy">
        {alert.options.title ? <strong className="gear-alert-title">{alert.options.title}</strong> : null}
        <div className="gear-alert-content">{alert.content}</div>
      </div>
      <button className="gear-alert-dismiss" onClick={close} type="button">
        Dismiss
      </button>
    </div>
  );
}
