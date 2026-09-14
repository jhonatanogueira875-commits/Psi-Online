import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

Deno.serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // TESTE MANUAL (GET)
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ status: "Webhook Psi Online ativo ✅" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN");

    if (!ACCESS_TOKEN) {
      return new Response(
        JSON.stringify({ erro: "MP_ACCESS_TOKEN não configurado." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Leitura dos dados da notificação do Mercado Pago
    const webhook = await req.json();
    const paymentId = webhook?.data?.id;

    if (!paymentId) {
      return new Response(
        JSON.stringify({ status: "ignorado", motivo: "Webhook sem payment_id." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Consulta detalhes do pagamento na API do Mercado Pago
    const resposta = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      }
    );

    const pagamento = await resposta.json();

    // Se o pagamento ainda não foi aprovado, ignorar no momento
    if (pagamento.status !== "approved") {
      return new Response(
        JSON.stringify({ status: pagamento.status }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Processar external_reference (esperado formato: "availabilityID|patientID")
    const externalRef = pagamento.external_reference || "";
    const [availabilityId, patientId] = externalRef.split("|");

    if (!availabilityId || !patientId) {
      console.error("Referência externa inválida:", externalRef);
      return new Response(
        JSON.stringify({ status: "erro", motivo: "external_reference formato inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Buscar a disponibilidade para pegar a data, horário e id do psicólogo
    const { data: slot, error: slotError } = await supabase
      .from("availability")
      .select("*")
      .eq("id", availabilityId)
      .single();

    if (slotError || !slot) {
      console.error("Horário não encontrado:", slotError);
      return new Response(
        JSON.stringify({ status: "erro", motivo: "Horário não encontrado." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Evitar duplicidade de agendamento se o webhook enviar 2 notificações seguidas
    const { data: appointmentExistente } = await supabase
      .from("appointments")
      .select("id")
      .eq("payment_id", String(paymentId))
      .maybeSingle();

    if (appointmentExistente) {
      return new Response(
        JSON.stringify({ status: "pagamento já processado" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Atualizar status do horário para "booked"
    const { error: updateError } = await supabase
      .from("availability")
      .update({ status: "booked" })
      .eq("id", availabilityId);

    if (updateError) throw updateError;

    // 4. Criar o agendamento na tabela appointments
    const { error: insertError } = await supabase
      .from("appointments")
      .insert({
        availability_id: availabilityId,
        psychologist_id: slot.psychologist_id,
        patient_id: patientId,
        date: slot.date,
        start_time: slot.start_time,
        end_time: slot.end_time,
        status: "confirmed",
        payment_id: String(paymentId),
        amount_paid: pagamento.transaction_amount
      });

    if (insertError) throw insertError;

    console.log("=================================");
    console.log("CONSULTA AGENDADA COM SUCESSO!");
    console.log("Paciente:", patientId);
    console.log("Psicólogo:", slot.psychologist_id);
    console.log("Data:", slot.date);
    console.log("=================================");

    return new Response(
      JSON.stringify({ status: "ok", agendamento_confirmado: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (erro: any) {
    console.error("Erro no Webhook:", erro);
    return new Response(
      JSON.stringify({ erro: erro.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});