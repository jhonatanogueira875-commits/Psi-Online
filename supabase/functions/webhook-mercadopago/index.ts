import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

    // Tentar extrair ID tanto do Corpo quanto dos Parâmetros da URL (Query Params)
    const url = new URL(req.url);
    const paramId = url.searchParams.get("id") || url.searchParams.get("data.id");
    const topic = url.searchParams.get("topic") || url.searchParams.get("type");

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let paymentId = body?.data?.id || paramId;

    // Se a notificação for do tipo merchant_order, buscamos o payment_id dentro da ordem
    if ((topic === "merchant_order" || body?.topic === "merchant_order" || body?.type === "merchant_order") && paramId) {
      const resOrder = await fetch(`https://api.mercadopago.com/merchant_orders/${paramId}`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      });
      if (resOrder.ok) {
        const orderData = await resOrder.json();
        if (orderData.payments && orderData.payments.length > 0) {
          // Pega o último pagamento associado à ordem
          paymentId = orderData.payments[orderData.payments.length - 1].id;
        }
      }
    }

    if (!paymentId) {
      console.log("Webhook recebido sem paymentId processável.");
      return new Response(
        JSON.stringify({ status: "ignorado", motivo: "Webhook sem payment_id processável." }),
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

    if (!resposta.ok || pagamento.status !== "approved") {
      return new Response(
        JSON.stringify({ status: pagamento.status || "não_aprovado" }),
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

    // 1. Buscar o horário para pegar data, início, fim e psicólogo
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

    // 2. Evitar duplicidades de inserção no banco
    const { data: appointmentExistente } = await supabase
      .from("appointments")
      .select("id")
      .eq("payment_id", String(paymentId))
      .maybeSingle();

    if (appointmentExistente) {
      return new Response(
        JSON.stringify({ status: "pagamento já processado anteriormente" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Atualizar status do horário na tabela availability para "booked"
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
        price: pagamento.transaction_amount || 0
      });

    if (insertError) throw insertError;

    console.log("=================================");
    console.log("CONSULTA AGENDADA COM SUCESSO!");
    console.log("=================================");

    return new Response(
      JSON.stringify({ status: "ok", agendamento_confirmado: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (erro: any) {
    console.error("Erro no Webhook:", erro);
    return new Response(
      JSON.stringify({ erro: erro.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});