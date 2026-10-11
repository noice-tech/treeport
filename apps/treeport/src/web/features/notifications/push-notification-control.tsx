import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { parseResponse, rpc } from '../../api'
import { notifyError } from './error-notifications'

export function PushNotificationControl() {
  const supported =
    window.isSecureContext &&
    !window.treeportDesktop &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  const [subscription, setSubscription] = useState<PushSubscription | null>(
    null
  )
  const [pending, setPending] = useState(supported)
  const [denied, setDenied] = useState(
    supported && Notification.permission === 'denied'
  )

  useEffect(() => {
    if (!supported) {
      return
    }

    let cancelled = false
    void navigator.serviceWorker
      .getRegistration('/')
      .then(async (registration) => {
        const current =
          (await registration?.pushManager.getSubscription()) ?? null
        if (!cancelled) {
          setSubscription(current)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          notifyError(error, { operation: 'check push notifications' })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPending(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [supported])

  const toggle = async () => {
    // The permission request must be the first async browser call in this user
    // gesture. In particular, iOS disallows asking after registering a worker.
    setPending(true)
    try {
      const permission = subscription
        ? Notification.permission
        : await Notification.requestPermission()
      setDenied(permission === 'denied')
      if (!subscription && permission !== 'granted') {
        return
      }

      if (subscription) {
        // Remove server delivery first so a failed API request remains retryable.
        await parseResponse(
          rpc.api.push.unsubscribe.$post(subscription.endpoint)
        )
        await subscription.unsubscribe()
        setSubscription(null)
        return
      }

      const { publicKey } = await parseResponse(rpc.api.push.config.$get())
      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      let timeout: ReturnType<typeof setTimeout> | null = null
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('Notification service worker did not become ready')
              ),
            10_000
          )
        })
      ]).finally(() => {
        if (timeout) {
          clearTimeout(timeout)
        }
      })
      const bytes = Uint8Array.from(
        atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (character) => character.charCodeAt(0)
      )
      const current =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes
        }))
      const keys = current.toJSON().keys
      if (!keys?.p256dh || !keys.auth) {
        throw new Error('Browser returned an invalid push subscription')
      }

      await parseResponse(
        rpc.api.push.subscribe.$post({
          endpoint: current.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth }
        })
      ).catch(async (error: Error) => {
        // Do not leave a browser-only subscription that looks enabled after
        // reopening the notification center. Enabling can then be retried.
        await current.unsubscribe()
        throw error
      })
      setSubscription(current)
    } catch (error) {
      notifyError(error, {
        operation: subscription
          ? 'disable push notifications'
          : 'enable push notifications'
      })
    } finally {
      setPending(false)
    }
  }

  if (window.treeportDesktop) {
    return null
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border p-3">
      {supported ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending || (denied && !subscription)}
          onClick={() => {
            void toggle()
          }}
        >
          {pending
            ? 'Checking notifications…'
            : subscription
              ? 'Disable push notifications'
              : 'Enable push notifications'}
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {denied
          ? 'Notifications are blocked. Allow them in your browser settings.'
          : supported
            ? 'Receive terminal bells even when Treeport is closed.'
            : 'Push notifications require HTTPS and a supported browser. On iOS, add Treeport to your Home Screen.'}
      </p>
    </div>
  )
}
