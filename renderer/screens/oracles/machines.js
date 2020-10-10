import {Machine, assign, spawn} from 'xstate'
import {log, sendParent} from 'xstate/lib/actions'
import {
  fetchVotings,
  createContractCaller,
  buildContractDeploymentParams,
  ContractRpcMode,
  isVotingStatus,
  isVotingMiningStatus,
  eitherStatus,
  createContractReadonlyCaller,
  createContractDataReader,
  buildDynamicArgs,
  contractMaxFee,
  setVotingStatus,
  votingFinishDate,
  byContractHash,
  hexToObject,
} from './utils'
import {VotingStatus} from '../../shared/types'
import {callRpc, merge} from '../../shared/utils/utils'
import {epochDb} from '../../shared/utils/db'
import {HASH_IN_MEMPOOL} from '../../shared/hooks/use-tx'

export const votingListMachine = Machine(
  {
    context: {
      votings: [],
      filter: VotingStatus.Open,
      showAll: false,
    },
    on: {
      REFRESH: 'loading',
      ERROR: {
        actions: ['onError'],
      },
    },
    initial: 'preload',
    states: {
      preload: {
        invoke: {
          src: 'loadFilter',
          onDone: {
            target: 'loading',
            actions: ['applyFilter', log()],
          },
          onError: {
            target: 'loading',
            actions: ['onError', log()],
          },
        },
      },
      loading: {
        invoke: {
          src: 'loadVotings',
          onDone: {
            target: 'loaded',
            actions: ['applyVotings', log()],
          },
          onError: {
            target: 'failure',
            actions: [log()],
          },
        },
      },
      loaded: {
        on: {
          FILTER: {
            target: 'loading',
            actions: ['setFilter', 'persistFilter'],
          },
          TOGGLE_SHOW_ALL: {
            target: 'loading',
            actions: ['toggleShowAll', 'persistFilter'],
          },
        },
      },
      failure: {},
    },
  },
  {
    actions: {
      applyVotings: assign({
        votings: ({epoch, identity}, {data}) =>
          data.map(voting => ({
            ...voting,
            ref: spawn(
              // eslint-disable-next-line no-use-before-define
              votingMachine.withContext({
                ...voting,
                epoch,
                identity,
              }),
              `voting-${voting.id}`
            ),
          })),
      }),
      applyFilter: assign((context, {data}) => ({
        ...context,
        ...data,
      })),
      setFilter: assign({
        filter: (_, {filter}) => filter,
      }),
      toggleShowAll: assign({
        showAll: ({showAll}) => !showAll,
      }),
      persistFilter: ({filter, showAll}) => {
        global
          .sub(global.db, 'votings', {valueEncoding: 'json'})
          .put('filter', {filter, showAll})
      },
    },
    services: {
      loadVotings: async ({
        epoch: {epoch},
        identity: {address},
        filter,
        showAll,
      }) => {
        const knownVotings = await fetchVotings({
          all: showAll.toString(),
          oracle: address,
          state: filter,
        })

        const enrichedKnownVotings = await Promise.all(
          knownVotings.map(async ({contractAddress, ...voting}) => {
            let votingMinPayment

            try {
              votingMinPayment = Number(
                await createContractDataReader({contractHash: contractAddress})(
                  'votingMinPayment',
                  'dna'
                )
              )
            } catch {
              votingMinPayment = 0
            }

            return {
              contractAddress,
              votingMinPayment,
              ...voting,
            }
          })
        )

        const normalizedKnownVotings = enrichedKnownVotings.map(
          ({contractAddress, fact, state, balance, ...voting}) => ({
            ...voting,
            status: state,
            fundingAmount: balance,
            contractHash: contractAddress,
            ...hexToObject(fact),
          })
        )

        const db = epochDb('votings', epoch)

        const persistedVotings = (await db.all()).filter(voting =>
          normalizedKnownVotings.some(byContractHash(voting))
        )

        const votings = merge(byContractHash)(
          persistedVotings,
          normalizedKnownVotings
        )

        await db.putMany(votings)

        return votings
      },
      loadFilter: async ({filter}) => {
        try {
          return JSON.parse(
            await global.sub(global.db, 'votings').get('filter')
          )
        } catch (error) {
          if (error.notFound) return filter
          throw new Error(error)
        }
      },
    },
  }
)

export const votingMachine = Machine(
  {
    id: 'voting',
    initial: 'unknown',
    states: {
      unknown: {
        on: {
          '': [
            {target: 'idle.resolveStatus', cond: 'isIdle'},
            {target: 'mining.resolveStatus', cond: 'isMining'},
            {
              target: VotingStatus.Invalid,
              cond: ({status}) => status === VotingStatus.Invalid,
            },
          ],
        },
      },
      idle: {
        initial: 'resolveStatus',
        states: {
          resolveStatus: {
            on: {
              '': [
                {
                  target: VotingStatus.Pending,
                  cond: 'isPending',
                },
                {
                  target: VotingStatus.Open,
                  cond: 'isRunning',
                },
                {
                  target: VotingStatus.Voted,
                  cond: 'isVoted',
                },
                {
                  target: VotingStatus.Counting,
                  cond: 'isCounting',
                },
                {
                  target: VotingStatus.Archived,
                  cond: 'isArchived',
                },
                {
                  target: `#voting.${VotingStatus.Invalid}`,
                  actions: ['setInvalid', 'persist'],
                },
              ],
            },
          },
          [VotingStatus.Pending]: {
            on: {
              START_VOTING: {
                target: `#voting.mining.${VotingStatus.Starting}`,
                actions: ['setStarting', 'persist'],
              },
            },
          },
          [VotingStatus.Open]: {},
          [VotingStatus.Voted]: {},
          [VotingStatus.Counting]: {},
          [VotingStatus.Archived]: {},
          hist: {
            type: 'history',
          },
        },
        on: {
          ADD_FUND: {
            target: 'mining.funding',
            actions: ['setFunding', 'persist', log()],
          },
        },
      },
      mining: votingMiningStates('voting'),
      [VotingStatus.Invalid]: {
        on: {
          ADD_FUND: {
            target: 'mining.funding',
            actions: ['setFunding', 'persist', log()],
          },
        },
      },
    },
  },
  {
    actions: {
      setPending: setVotingStatus(VotingStatus.Pending),
      setFunding: assign({
        prevStatus: ({status}) => status,
        status: VotingStatus.Funding,
        fundingAmount: ({fundingAmount = 0}, {amount}) =>
          fundingAmount + amount,
      }),
      setStarting: setVotingStatus(VotingStatus.Starting),
      setRunning: setVotingStatus(VotingStatus.Open),
      setInvalid: assign({
        status: VotingStatus.Invalid,
        errorMessage: (_, {error}) => error?.message,
      }),
      restorePrevStatus: assign({
        status: ({status, prevStatus}) => prevStatus || status,
      }),
      applyTx: assign({
        txHash: (_, {data}) => data,
      }),
      handleError: assign({
        errorMessage: (_, {error}) => error,
      }),
      onError: sendParent((_, {data}) => ({type: 'ERROR', data})),
      clearMiningStatus: assign({
        miningStatus: null,
      }),
      persist: ({epoch: {epoch}, ...context}) => {
        epochDb('votings', epoch).put(context)
      },
    },
    services: {
      ...votingServices(),
      pollStatus: ({txHash}) => cb => {
        let timeoutId

        const fetchStatus = async () => {
          try {
            const result = await callRpc('bcn_transaction', txHash)
            if (result.blockHash !== HASH_IN_MEMPOOL) {
              cb('MINED')
            } else {
              timeoutId = setTimeout(fetchStatus, 10 * 1000)
            }
          } catch (error) {
            cb('TX_NULL', {error})
          }
        }

        timeoutId = setTimeout(fetchStatus, 10 * 1000)

        return () => {
          clearTimeout(timeoutId)
        }
      },
    },
    guards: {
      ...votingStatusGuards(),
    },
  }
)

export const createNewVotingMachine = epoch =>
  Machine(
    {
      context: {
        epoch: {
          epoch,
        },
        options: [0, 1],
      },
      initial: 'editing',
      states: {
        editing: {
          on: {
            CHANGE: {
              actions: ['setContractParams', log()],
            },
            SET_OPTIONS: {
              actions: ['setOptions', log()],
            },
            SET_OPTIONS_NUMBER: {
              actions: ['setOptionsNumber'],
            },
            PUBLISH: {
              target: 'publishing',
              actions: [log()],
            },
          },
        },
        publishing: {
          initial: 'deployingContract',
          states: {
            deployingContract: {
              initial: 'estimating',
              states: {
                estimating: {
                  invoke: {
                    src: 'estimateDeployContract',
                    onDone: {
                      target: 'deploying',
                      actions: ['applyDeployResult', log()],
                    },
                    onError: {
                      actions: ['onDeployFailed', log()],
                    },
                  },
                },
                deploying: {
                  invoke: {
                    src: 'deployContract',
                    onDone: {
                      target: 'done',
                      actions: ['applyContractHash', log()],
                    },
                    onError: {
                      actions: ['onDeployFailed', log()],
                    },
                  },
                },
                done: {
                  entry: ['onDeployed'],
                },
              },
            },
          },
        },
      },
    },
    {
      actions: {
        applyDeployResult: assign(
          (
            context,
            {data: {contract: contractHash, txHash, gasCost, txFee}}
          ) => ({
            ...context,
            contractHash,
            txHash,
            gasCost: Number(gasCost),
            txFee: Number(txFee),
          })
        ),
        applyContractHash: assign({
          txHash: (_, {data}) => data,
        }),
        setContractParams: assign((context, {id, value}) => ({
          ...context,
          [id]: value,
        })),
        setOptions: assign(({options, ...context}, {idx, value}) => ({
          ...context,
          options: [...options.slice(0, idx), value, ...options.slice(idx + 1)],
        })),
        setOptionsNumber: assign({
          maxOptions: (_, {value}) => value,
          options: ({options}, {value}) =>
            value > options.length
              ? options.concat(
                  Array.from({length: value - options.length}, () => null)
                )
              : options.slice(0, value),
        }),
      },
      services: {
        estimateDeployContract: async ({identity, ...voting}) => {
          const {error, ...result} = await callRpc(
            'contract_estimateDeploy',
            buildContractDeploymentParams(
              voting,
              identity,
              ContractRpcMode.Estimate
            )
          )
          if (error) throw new Error(error)
          return result
        },
        // eslint-disable-next-line no-shadow
        deployContract: async ({epoch: {epoch}, identity, ...voting}) => {
          const deployResult = await callRpc(
            'contract_deploy',
            buildContractDeploymentParams(voting, identity)
          )

          await epochDb('votings', epoch).put({
            ...voting,
            txHash: deployResult,
            issuer: identity.address,
            finishDate: votingFinishDate(voting),
            status: VotingStatus.Deploying,
          })

          return deployResult
        },
      },
    }
  )

export const createViewVotingMachine = (id, epoch, address) =>
  Machine(
    {
      id: 'viewVoting',
      context: {
        id,
        epoch,
        address,
      },
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'loadVoting',
            onDone: {
              target: 'idle',
              actions: ['applyVoting', log()],
            },
            onError: {
              target: 'invalid',
              actions: [log()],
            },
          },
        },
        idle: {
          initial: 'resolveStatus',
          states: {
            resolveStatus: {
              on: {
                '': [
                  {
                    target: VotingStatus.Pending,
                    cond: 'isPending',
                  },
                  {
                    target: VotingStatus.Open,
                    cond: 'isRunning',
                  },
                  {
                    target: VotingStatus.Voted,
                    cond: 'isVoted',
                  },
                  {
                    target: VotingStatus.Counting,
                    cond: 'isCounting',
                  },
                  {
                    target: VotingStatus.Archived,
                    cond: 'isArchived',
                  },
                  {
                    target: `#viewVoting.${VotingStatus.Invalid}`,
                    actions: ['setInvalid', 'persist'],
                  },
                ],
              },
            },
            [VotingStatus.Pending]: {
              on: {
                START_VOTING: {
                  target: `#viewVoting.mining.${VotingStatus.Starting}`,
                  actions: ['setStarting', 'persist'],
                },
              },
            },
            [VotingStatus.Open]: {},
            [VotingStatus.Voted]: {},
            [VotingStatus.Counting]: {
              on: {
                FINISH_VOTING: `#viewVoting.mining.finishVoting`,
              },
            },
            [VotingStatus.Archived]: {},
            hist: {
              type: 'hist',
            },
          },
          on: {
            ADD_FUND: {
              target: `mining.${VotingStatus.Funding}`,
              actions: ['setFunding', 'persist', log()],
            },
            START_VOTING: `mining.${VotingStatus.Starting}`,
            SELECT_OPTION: {
              actions: ['selectOption', log()],
            },
            VOTE: 'mining.voting',
            TERMINATE_CONTRACT: `mining.${VotingStatus.Terminating}`,
          },
        },
        mining: votingMiningStates('viewVoting'),
        invalid: {},
      },
    },
    {
      actions: {
        setFunding: assign({
          prevStatus: ({status}) => status,
          status: VotingStatus.Funding,
          fundingAmount: ({fundingAmount = 0}, {amount}) =>
            Number(fundingAmount) + Number(amount),
        }),
        setStarting: setVotingStatus(VotingStatus.Starting),
        setRunning: assign({
          prevStatus: ({status}) => status,
          status: VotingStatus.Open,
        }),
        applyVoting: assign((context, {data}) => ({
          ...context,
          ...data,
        })),
        setVoted: assign({
          status: VotingStatus.Voted,
        }),
        setInvalid: assign({
          status: VotingStatus.Invalid,
          errorMessage: (_, {error}) => error?.message,
        }),
        restorePrevStatus: assign({
          status: ({prevStatus}) => prevStatus,
        }),
        applyTx: assign({
          txHash: (_, {data}) => data,
        }),
        handleError: assign({
          errorMessage: (_, {error}) => error,
        }),
        clearMiningStatus: assign({
          miningStatus: null,
        }),
        selectOption: assign({
          selectedOption: ({options}, {option}) =>
            options.findIndex(o => o.toUpperCase() === option.toUpperCase()),
        }),
        // eslint-disable-next-line no-shadow
        persist: ({epoch, ...context}) => {
          epochDb('votings', epoch).put(context)
        },
      },
      services: {
        // eslint-disable-next-line no-shadow
        loadVoting: async ({epoch, id}) => epochDb('votings', epoch).load(id),
        ...votingServices(),
        vote: async ({
          // eslint-disable-next-line no-shadow
          address,
          issuer = address,
          contractHash,
          amount,
          selectedOption,
          gasCost,
          txFee,
        }) => {
          const readonlyCallContract = createContractReadonlyCaller({
            contractHash,
          })
          const readContractData = createContractDataReader({contractHash})

          const proof = await readonlyCallContract('proof', 'hex', {
            value: address,
          })

          const {error} = proof
          if (error) throw new Error(error)

          const voteHash = await readonlyCallContract(
            'voteHash',
            'hex',
            {value: selectedOption.toString(), format: 'byte'},
            {value: issuer}
          )

          const votingMinPayment = Number(
            await readContractData('votingMinPayment', 'dna')
          )

          const voteBlock = Number(
            await readonlyCallContract('voteBlock', 'uint64')
          )

          let callContract = createContractCaller({
            issuer,
            contractHash,
            amount: votingMinPayment || amount,
            broadcastBlock: voteBlock,
            gasCost,
            txFee,
          })

          const {
            error: errorProof,
            gasCost: callGasCost,
            txFee: callTxFee,
          } = await callContract('sendVoteProof', ContractRpcMode.Estimate, {
            value: voteHash,
          })

          if (errorProof) throw new Error(errorProof)

          callContract = createContractCaller({
            issuer,
            contractHash,
            amount: votingMinPayment || amount,
            broadcastBlock: voteBlock,
            gasCost: Number(callGasCost),
            txFee: Number(callTxFee),
          })

          const voteProofResp = await callContract(
            'sendVoteProof',
            ContractRpcMode.Call,
            {
              value: voteHash,
            }
          )

          await callContract(
            'sendVote',
            ContractRpcMode.Call,
            {value: selectedOption.toString(), format: 'byte'},
            {value: issuer}
          )

          return voteProofResp
        },
        finishVoting: async contract => {
          let callContract = createContractCaller(contract)

          const {error, gasCost, txFee} = await callContract(
            'finishVoting',
            ContractRpcMode.Estimate
          )
          if (error) throw new Error(error)

          callContract = createContractCaller({
            ...contract,
            gasCost: Number(gasCost),
            txFee: Number(txFee),
          })

          return callContract('finishVoting')
        },
        terminateContract: async ({
          // eslint-disable-next-line no-shadow
          address,
          issuer = address,
          contractHash,
        }) => {
          const payload = {
            from: issuer,
            contract: contractHash,
            args: buildDynamicArgs({value: issuer}),
          }

          const {error, gasCost, txFee} = await callRpc(
            'contract_estimateTerminate',
            payload
          )
          if (error) throw new Error(error)

          return callRpc('contract_terminate', {
            ...payload,
            maxFee: contractMaxFee(gasCost, txFee),
          })
        },
        pollStatus: ({txHash}) => cb => {
          let timeoutId

          const fetchStatus = async () => {
            try {
              const result = await callRpc('bcn_transaction', txHash)
              if (result.blockHash !== HASH_IN_MEMPOOL) {
                cb('MINED')
              } else {
                timeoutId = setTimeout(fetchStatus, 10 * 1000)
              }
            } catch (error) {
              cb('TX_NULL', {error: error?.message})
            }
          }

          timeoutId = setTimeout(fetchStatus, 10 * 1000)

          return () => {
            clearTimeout(timeoutId)
          }
        },
      },
      guards: {
        // eslint-disable-next-line no-use-before-define
        ...votingStatusGuards(),
      },
    }
  )

function votingMiningStates(machineId) {
  return {
    initial: 'resolveStatus',
    states: {
      resolveStatus: {
        on: {
          '': [
            {
              target: VotingStatus.Deploying,
              cond: 'isDeploying',
            },
            {
              target: VotingStatus.Funding,
              cond: 'isFunding',
            },
            {
              target: VotingStatus.Starting,
              cond: 'isStarting',
            },
          ],
        },
      },
      [VotingStatus.Deploying]: {
        invoke: {
          src: 'pollStatus',
        },
        on: {
          MINED: {
            target: `#${machineId}.idle.${VotingStatus.Pending}`,
            actions: ['setPending', 'clearMiningStatus', 'persist', log()],
          },
        },
      },
      [VotingStatus.Funding]: {
        initial: 'checkMiningStatus',
        states: {
          checkMiningStatus: {
            on: {
              '': [
                {
                  target: 'submitting',
                  cond: 'shouldSubmit',
                },
                {
                  target: 'mining',
                  cond: 'shouldPollStatus',
                },
                {
                  target: `#${machineId}.invalid`,
                  actions: ['setInvalid', 'persist'],
                },
              ],
            },
          },
          submitting: {
            invoke: {
              src: 'addFund',
              onDone: {
                target: 'mining',
                actions: ['applyTx'],
              },
              onError: {
                target: `#${machineId}.idle.hist`,
                actions: ['handleError', 'onError', 'restorePrevStatus', log()],
              },
            },
          },
          mining: {
            entry: [
              assign({
                miningStatus: 'mining',
              }),
              'persist',
            ],
            invoke: {
              src: 'pollStatus',
            },
            on: {
              MINED: {
                target: `#${machineId}.idle.hist`,
                actions: [
                  'restorePrevStatus',
                  'clearMiningStatus',
                  'persist',
                  log(),
                ],
              },
            },
          },
        },
      },
      [VotingStatus.Starting]: {
        initial: 'checkMiningStatus',
        states: {
          checkMiningStatus: {
            on: {
              '': [
                {
                  target: 'submitting',
                  cond: 'shouldSubmit',
                },
                {
                  target: 'mining',
                  cond: 'shouldPollStatus',
                },
                {
                  target: `#${machineId}.invalid`,
                  actions: ['setInvalid', 'persist'],
                },
              ],
            },
          },
          submitting: {
            invoke: {
              src: 'startVoting',
              onDone: {
                target: 'mining',
                actions: ['applyTx', log()],
              },
              onError: {
                target: `#${machineId}.idle.hist`,
                actions: ['handleError', 'onError', 'restorePrevStatus', log()],
              },
            },
          },
          mining: {
            entry: [
              assign({
                miningStatus: 'mining',
              }),
              'persist',
            ],
            invoke: {
              src: 'pollStatus',
            },
            on: {
              MINED: {
                target: `#${machineId}.idle.${VotingStatus.Open}`,
                actions: ['setRunning', 'clearMiningStatus', 'persist', log()],
              },
            },
          },
        },
      },
      voting: {
        invoke: {
          src: 'vote',
          onDone: {
            target: `#${machineId}.idle.${VotingStatus.Voted}`,
            actions: ['setVoted', 'applyTx', 'persist', log()],
          },
          onError: {
            target: `#${machineId}.invalid`,
            actions: ['onError', log()],
          },
        },
      },
      finishVoting: {
        invoke: {
          src: 'finishVoting',
          onDone: {
            actions: [
              assign({
                status: VotingStatus.Archived,
              }),
              'applyTx',
              'persist',
              log(),
            ],
          },
          onError: {
            actions: ['onError', 'restorePrevStatus', log()],
          },
        },
      },
      [VotingStatus.Terminating]: {
        invoke: {
          src: 'terminateContract',
          onDone: {
            actions: [log()],
          },
          onError: {
            actions: ['onError', log()],
          },
        },
      },
    },
    on: {
      TX_NULL: {
        target: 'invalid',
        actions: ['setInvalid', 'clearMiningStatus', log()],
      },
    },
  }
}

function votingServices() {
  return {
    addFund: ({contractHash}, {amount, from}) =>
      callRpc('dna_sendTransaction', {
        to: contractHash,
        from,
        amount,
      }),
    startVoting: async contract => {
      let callContract = createContractCaller(contract)

      const {error, gasCost, txFee} = await callContract(
        'startVoting',
        ContractRpcMode.Estimate
      )
      if (error) throw new Error(error)

      callContract = createContractCaller({
        ...contract,
        gasCost: Number(gasCost),
        txFee: Number(txFee),
      })

      return callContract('startVoting')
    },
  }
}

function votingStatusGuards() {
  return {
    isIdle: eitherStatus(
      VotingStatus.Pending,
      VotingStatus.Open,
      VotingStatus.Voted,
      VotingStatus.Counting,
      VotingStatus.Archived
    ),
    isMining: ({status, txHash}) =>
      Boolean(txHash) &&
      eitherStatus(
        VotingStatus.Deploying,
        VotingStatus.Funding,
        VotingStatus.Starting,
        VotingStatus.Terminating
      )({status}),
    isDeploying: isVotingMiningStatus(VotingStatus.Deploying),
    isFunding: isVotingMiningStatus(VotingStatus.Funding),
    isStarting: isVotingMiningStatus(VotingStatus.Starting),
    isPending: isVotingStatus(VotingStatus.Pending),
    isRunning: isVotingStatus(VotingStatus.Open),
    isVoted: isVotingStatus(VotingStatus.Voted),
    isCounting: isVotingStatus(VotingStatus.Counting),
    isArchived: isVotingStatus(VotingStatus.Archived),
    shouldSubmit: ({miningStatus}) => !miningStatus,
    shouldPollStatus: ({miningStatus}) => miningStatus === 'mining',
  }
}