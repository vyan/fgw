((
  { config, isDebugEnabled } = pipy.solve('config.js'),

  hcLogging = config?.Configs?.HealthCheckLog?.StorageAddress && new logging.JSONLogger('health-check-logger').toHTTP(config.Configs.HealthCheckLog.StorageAddress, {
    batch: {
      timeout: 1,
      interval: 1,
      prefix: '[',
      postfix: ']',
      separator: ','
    },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.Configs.HealthCheckLog.Authorization || ''
    }
  }).log,

  k8s_cluster = os.env.PIPY_K8S_CLUSTER || '',
  code_base = pipy.source || '',
  pipy_id = pipy.name || '',

  { metrics } = pipy.solve('lib/metrics.js'),

  healthCheckTargets = {},

  healthCheckServices = {},

  makeHealthCheck = (serviceConfig) => (
    serviceConfig?.HealthCheck && (
      (
        name = serviceConfig.name,
        interval = serviceConfig.HealthCheck?.Interval, // || 15, active
        maxFails = serviceConfig.HealthCheck?.MaxFails, // || 3, both
        failTimeout = serviceConfig.HealthCheck?.FailTimeout, // || 300, passivity
        uri = serviceConfig.HealthCheck?.Uri, // for HTTP
        matches = serviceConfig.HealthCheck?.Matches || [{ Type: "status", Value: [200] }], // for HTTP
        type = uri ? 'HTTP' : 'TCP',
      ) => (
        {
          name,
          interval,
          maxFails,
          failTimeout,
          uri,
          matches,

          toString: () => (
            'service: ' + name + ', interval: ' + interval + ', maxFails: ' + maxFails + ', uri: ' + uri + ', matches: ' + matches
          ),

          ok: target => (
            (target.alive === 0) && (
              target.alive = 1,
              target.errorCount = 0,
              healthCheckServices[name] && healthCheckServices[name].get(target.target) && (
                healthCheckServices[name].remove(target.target)
              ),
              isDebugEnabled && (
                console.log('[health-check] ok - service, type, target:', name, type, target)
              )
            ),
            metrics.fgwUpstreamStatus.withLabels(
              name,
              target.ip,
              target.port,
              target.reason = 'ok',
              target.http_status || ''
            ).increase(),
            hcLogging?.({
              k8s_cluster,
              code_base,
              pipy_id,
              upstream_ip: target.ip,
              upstream_port: target.port,
              type: 'ok',
              http_status: target.http_status || ''
            })
          ),

          fail: target => (
            (++target.errorCount >= maxFails && target.alive) && (
              target.alive = 0,
              target.failTick = 0,
              !healthCheckServices[name] ? (
                healthCheckServices[name] = new algo.Cache(),
                healthCheckServices[name].set(target.target, true)
              ) : (
                !healthCheckServices[name].get(target.target) && (
                  healthCheckServices[name].set(target.target, true)
                )
              ),
              isDebugEnabled && (
                console.log('[health-check] fail - service, type, target:', name, type, target)
              )
            ),
            metrics.fgwUpstreamStatus.withLabels(
              name,
              target.ip,
              target.port,
              target.reason || 'fail',
              target.http_status || ''
            ).decrease(),
            hcLogging?.({
              k8s_cluster,
              code_base,
              pipy_id,
              upstream_ip: target.ip,
              upstream_port: target.port,
              type: target.reason || 'fail',
              http_status: target.http_status || ''
            })
          ),

          available: target => (
            target.alive > 0
          ),

          match: msg => (
            (
              match_rules = matches.map(
                m => (
                  (m?.Type === 'status') ? (
                    msg => (
                      m?.Value?.includes(msg?.head?.status)
                    )
                  ) : (
                    (m?.Type === 'body') ? (
                      msg => (
                        msg?.body?.toString?.()?.includes(m?.Value)
                      )
                    ) : (
                      (m?.Type === 'headers') ? (
                        msg => (
                          msg?.head?.headers?.[m?.Name?.toLowerCase?.()] === m?.Value
                        )
                      ) : (
                        () => false
                      )
                    )
                  )
                )
              ),
            ) => (
              match_rules.every(m => m(msg))
            )
          )(),

          check: target => (
            new http.Agent(target.target).request('GET', uri).then(
              result => (
                target.http_status = result?.head?.status,
                target.service.match(result) ? (
                  target.service.ok(target)
                ) : (
                  target.reason = "BadHttpStatus",
                  target.service.fail(target)
                ),
                {}
              )
            )
          ),
        }
      )
    )()
  ),

  healthCheckCache = new algo.Cache(makeHealthCheck),

) => pipy({
  _idx: 0,
  _service: null,
  _target: null,
  _resolve: null,
  _tcpTargets: null,
  _targetPromises: null,
})

.export('health-check', {
  __healthCheckTargets: healthCheckTargets,
  __healthCheckServices: healthCheckServices,
})

.pipeline()
.onStart(
  () => void (
    Object.keys(config?.Services || {}).forEach(
      name => (
        (config.Services[name]?.HealthCheck?.MaxFails > 0) && (
          config.Services[name].HealthCheck.Interval > 0 || config.Services[name].HealthCheck.FailTimeout > 0
        ) && (
          config.Services[name].name = name,
          (_service = healthCheckCache.get(config.Services[name])) && (
            Object.keys(config.Services[name].Endpoints || {}).forEach(
              target => (
                _idx = target.lastIndexOf(':'),
                healthCheckTargets[target + '@' + name] = {
                  ip: target.substring(0, _idx),
                  port: target.substring(_idx + 1),
                  target,
                  service: _service,
                  alive: 1,
                  errorCount: 0,
                  failTick: 0,
                  tick: 0,
                }
              )
            )
          )
        )
      )
    )
  )
)

.task('1s')
.onStart(
  () => new Message
)
.replaceMessage(
  msg => (
    _tcpTargets = [],
    _targetPromises = [],
    Object.values(healthCheckTargets).forEach(
      target => (
        (target.service.interval > 0 && ++target.tick >= target.service.interval) && (
          target.tick = 0,
          target.service.uri ? ( // for HTTP
            target.service.check(target)
          ) : ( // for TCP
            _targetPromises.push(new Promise(r => _resolve = r)),
            _tcpTargets.push(new Message({ target, resolve: _resolve }))
          )
        )
      )
    ),
    _tcpTargets.length > 0 ? _tcpTargets : msg
  )
)
.branch(
  () => _tcpTargets.length > 0, (
    $=>$
    .demux().to(
      $=>$.replaceMessage(
        msg => (
          _target = msg.head.target,
          _resolve = msg.head.resolve,
          new Data
        )
      )
      .connect(() => _target.target,
        {
          connectTimeout: 0.1,
          readTimeout: 0.1,
          idleTimeout: 0.1,
        }
      )
      .replaceData(
        () => new Data
      )
      .replaceStreamEnd(
        e => (
          (!e.error || e.error === "ReadTimeout" || e.error === "IdleTimeout") ? (
            _target.service.ok(_target)
          ) : (
            _target.reason = 'ConnectionRefused',
            _target.service.fail(_target)
          ),
          _resolve(),
          new Message
        )
      )
    )
    .wait(
      () => Promise.all(_targetPromises)
    )
  ), (
    $=>$
  )
)
.replaceMessage(
  () => new StreamEnd
)

.task('1s')
.onStart(
  () => new Message
)
.replaceMessage(
  () => (
    Object.values(healthCheckTargets).forEach(
      target => (
        (target.alive === 0 && target.service.failTimeout > 0 && !(target.service.interval > 0)) && (
          (++target.failTick >= target.service.failTimeout) && (
            isDebugEnabled && (
              console.log('[health-check] reset - service, type, target, failTick:', target.name, type, target.target, target.failTick)
            ),
            target.service.ok(target)
          )
        )
      )
    ),
    new StreamEnd
  )
)

)()